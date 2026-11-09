import * as SDK from "azure-devops-extension-sdk";
import { getClient } from "azure-devops-extension-api";
import { CoreRestClient } from "azure-devops-extension-api/Core";
import { GraphRestClient, GraphSubject, GraphTraversalDirection } from "azure-devops-extension-api/Graph";

/**
 * Each control on the work item form is hosted in its own iframe, so in-memory state is
 * not shared between buttons. All iframes of this extension share one origin, though, so
 * sessionStorage (shared per tab) is used to share the user-level lookups. A short TTL keeps
 * results from going stale for long; Web Locks (when available) make concurrently-loading
 * iframes wait for the first one to populate the cache instead of all fetching at once.
 */
const SHARED_TTL_MS = 2 * 60 * 1000;
const SHARED_PREFIX = "groupCheck:";

function readShared<T>(key: string): T | undefined {
    try {
        const raw = sessionStorage.getItem(SHARED_PREFIX + key);
        if (!raw) {
            return undefined;
        }
        const entry = JSON.parse(raw) as { t: number; v: T };
        return Date.now() - entry.t < SHARED_TTL_MS ? entry.v : undefined;
    } catch {
        return undefined;
    }
}

function writeShared(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(SHARED_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch {
        // Storage unavailable (sandboxed/blocked) - just skip cross-iframe sharing.
    }
}

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const locks = (navigator as any).locks;
    return locks?.request ? locks.request(SHARED_PREFIX + name, fn) : fn();
}

/** Memoize per iframe, share across iframes via storage; failures are never cached. */
function sharedOnce<T>(key: string, fetch: () => Promise<{ value: T; cacheable: boolean }>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => {
        if (!pending) {
            pending = withLock(key, async () => {
                const hit = readShared<T>(key);
                if (hit !== undefined) {
                    return hit;
                }
                const { value, cacheable } = await fetch();
                if (cacheable) {
                    writeShared(key, value);
                }
                return value;
            });
            pending.catch(() => { pending = undefined; });
        }
        return pending;
    };
}

interface GraphContext {
    projectDescriptor: string;
    /** Descriptors of every group the user belongs to, directly or transitively. */
    containers: string[];
}

let teamsLoader: (() => Promise<string[]>) | undefined;
let graphLoader: (() => Promise<GraphContext | undefined>) | undefined;
const groupDescriptorLoaders = new Map<string, () => Promise<string[]>>();
const resultCache = new Map<string, Promise<boolean>>();

function projectId(): string {
    return SDK.getPageContext().webContext.project.id;
}

/**
 * True when the signed-in user is a member of an ADO team or security group whose
 * name matches groupName (case-insensitive).
 *
 * Fails closed on any API error. User-level lookups (teams, memberships, descriptors)
 * are shared by every button on the page; only the name->group lookup is per group name.
 */
export function isCurrentUserInGroup(groupName: string): Promise<boolean> {
    const key = groupName.toLowerCase();
    if (!resultCache.has(key)) {
        resultCache.set(key, resolve(groupName).catch(() => false));
    }
    return resultCache.get(key)!;
}

async function resolve(groupName: string): Promise<boolean> {
    const needle = groupName.toLowerCase();

    const teamNames = await loadTeams();
    if (teamNames.includes(needle)) {
        return true;
    }

    const graph = await loadGraphContext();
    if (!graph) {
        return false;
    }

    const targets = await loadGroupDescriptors(groupName, graph.projectDescriptor);
    if (targets.length === 0) {
        return false;
    }
    const containers = new Set(graph.containers);
    return targets.some(d => containers.has(d));
}

function loadTeams(): Promise<string[]> {
    teamsLoader ??= sharedOnce(`teams:${projectId()}`, async () => {
        const coreClient = getClient(CoreRestClient);
        const pageSize = 100;
        const names: string[] = [];
        try {
            for (let skip = 0; ; skip += pageSize) {
                const page = await coreClient.getTeams(projectId(), /* mine */ true, pageSize, skip);
                names.push(...page.map(t => t.name.toLowerCase()));
                if (page.length < pageSize) {
                    break;
                }
            }
            return { value: names, cacheable: true };
        } catch {
            // Continue with Graph so a transient team API failure does not prevent
            // security-group membership from being resolved. Don't share a partial list.
            return { value: names, cacheable: false };
        }
    });
    return teamsLoader();
}

function loadGraphContext(): Promise<GraphContext | undefined> {
    graphLoader ??= sharedOnce<GraphContext | undefined>(`graph:${projectId()}:${SDK.getUser().id}`, async () => {
        const graphClient = getClient(GraphRestClient);

        // SDK.getUser().descriptor is not reliably populated by every host version/context,
        // and an empty descriptor makes listMemberships build a malformed URL (the
        // {subjectDescriptor} route segment is simply dropped, producing a 404 rather than
        // a clear error). Resolve it from the user's storage key instead.
        const [userDescriptor, projectDescriptor] = await Promise.all([
            resolveUserDescriptor(graphClient),
            graphClient.getDescriptor(projectId()).then(d => d.value)
        ]);
        if (!userDescriptor) {
            return { value: undefined, cacheable: false };
        }
        const containers = await listAllContainers(graphClient, userDescriptor);
        return { value: { projectDescriptor, containers }, cacheable: true };
    });
    return graphLoader();
}

function loadGroupDescriptors(groupName: string, projectDescriptor: string): Promise<string[]> {
    const key = groupName.toLowerCase();
    let loader = groupDescriptorLoaders.get(key);
    if (!loader) {
        loader = sharedOnce(`group:${projectId()}:${key}`, async () => {
            const groups = await findGroups(getClient(GraphRestClient), groupName, projectDescriptor);
            return { value: groups.map(g => g.descriptor), cacheable: true };
        });
        groupDescriptorLoaders.set(key, loader);
    }
    return loader();
}

async function resolveUserDescriptor(client: GraphRestClient): Promise<string | undefined> {
    const user = SDK.getUser();
    if (user.descriptor) {
        return user.descriptor;
    }
    const result = await client.getDescriptor(user.id);
    return result.value || undefined;
}

async function findGroups(
    client: GraphRestClient,
    groupName: string,
    projectDescriptor: string
): Promise<GraphSubject[]> {
    // Query project scope and organization scope independently; one failing (e.g. an
    // empty/unsupported scope) must not hide groups found by the other.
    const queries = [
        client.querySubjects({ query: groupName, subjectKind: ["Group"], scopeDescriptor: projectDescriptor }),
        client.querySubjects({ query: groupName, subjectKind: ["Group"] } as any)
    ].map(q => q.catch(e => {
        console.warn("groupCheck: group query failed", e);
        return [] as GraphSubject[];
    }));
    const results = await Promise.all(queries);
    const groups = new Map<string, GraphSubject>();
    const needle = groupName.toLowerCase();
    // SubjectQuery returns JSON `null` (not []) when nothing matches in a scope.
    for (const subject of results.flat().filter((s): s is GraphSubject => !!s)) {
        const display = (subject.displayName ?? "").toLowerCase();
        const principal = ((subject as any).principalName ?? "").toLowerCase();
        // principalName is "[Scope]\Group Name"; match either form.
        if (display === needle || principal.endsWith("\\" + needle)) {
            groups.set(subject.descriptor, subject);
        }
    }
    return [...groups.values()];
}

/**
 * Every group the user belongs to, directly or through nesting.
 *
 * The Graph API only supports depth=1 (anything else is a 400), so nesting has to be
 * walked. Each level is fetched in parallel, making the cost one round trip per level of
 * nesting rather than one per group.
 */
async function listAllContainers(client: GraphRestClient, userDescriptor: string): Promise<string[]> {
    const visited = new Set<string>([userDescriptor]);
    const containers = new Set<string>();
    let level = [userDescriptor];

    while (level.length > 0) {
        const results = await Promise.all(level.map(async descriptor => {
            // Org-level groups (and Entra-backed groups) can reject membership listing for
            // the caller. Skip that branch rather than failing the whole check.
            try {
                return (await client.listMemberships(descriptor, GraphTraversalDirection.Up)) ?? [];
            } catch (e) {
                console.warn(`groupCheck: could not list memberships for ${descriptor}`, e);
                return [];
            }
        }));

        const next: string[] = [];
        for (const memberships of results) {
            for (const { containerDescriptor } of memberships) {
                containers.add(containerDescriptor);
                // Defensive: an empty descriptor would build a URL with no
                // {subjectDescriptor} route segment, which the API 404s.
                if (containerDescriptor && !visited.has(containerDescriptor)) {
                    visited.add(containerDescriptor);
                    next.push(containerDescriptor);
                }
            }
        }
        level = next;
    }

    return [...containers];
}
