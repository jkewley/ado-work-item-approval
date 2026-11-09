import * as SDK from "azure-devops-extension-sdk";
import { getClient } from "azure-devops-extension-api";
import { CoreRestClient } from "azure-devops-extension-api/Core";
import { GraphRestClient, GraphSubject, GraphTraversalDirection } from "azure-devops-extension-api/Graph";

const MAX_MEMBERSHIP_DEPTH = 10;
const cache = new Map<string, Promise<boolean>>();

/**
 * True when the signed-in user is a member of an ADO team or security group whose
 * name matches groupName (case-insensitive).
 *
 * Fails closed on any API error. Cached for the iframe lifetime.
 */
export function isCurrentUserInGroup(groupName: string): Promise<boolean> {
    const key = groupName.toLowerCase();
    if (!cache.has(key)) {
        const p = resolve(groupName).catch(() => false);
        cache.set(key, p);
    }
    return cache.get(key)!;
}

async function resolve(groupName: string): Promise<boolean> {
    const projectId = SDK.getPageContext().webContext.project.id;
    const needle = groupName.toLowerCase();
    const coreClient = getClient(CoreRestClient);
    const pageSize = 100;
    let skip = 0;

    try {
        while (true) {
            const page = await coreClient.getTeams(projectId, /* mine */ true, pageSize, skip);
            if (page.some(t => t.name.toLowerCase() === needle)) {
                return true;
            }
            if (page.length < pageSize) {
                break;
            }
            skip += pageSize;
        }
    } catch {
        // Continue with Graph so a transient team API failure does not prevent
        // security-group membership from being resolved.
    }

    const graphClient = getClient(GraphRestClient);

    // SDK.getUser().descriptor is not reliably populated by every host version/context,
    // and an empty descriptor makes listMemberships build a malformed URL (the
    // {subjectDescriptor} route segment is simply dropped, producing a 404 rather than
    // a clear error). Resolve it from the user's storage key instead, the same way the
    // project id is resolved to a descriptor below.
    const userDescriptor = await resolveUserDescriptor(graphClient);
    if (!userDescriptor) {
        return false;
    }

    const projectDescriptor = await graphClient.getDescriptor(projectId);
    const groups = await findGroups(graphClient, groupName, projectDescriptor.value);
    if (groups.length === 0) {
        return false;
    }

    return hasGroupMembership(graphClient, userDescriptor, new Set(groups.map(group => group.descriptor)));
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

async function hasGroupMembership(
    client: GraphRestClient,
    userDescriptor: string,
    targetDescriptors: Set<string>
): Promise<boolean> {
    // Fast path: one call returns every transitive parent group of the user (depth > 1),
    // so only the name-matched target descriptors need comparing. Falls back to walking
    // level by level if the server rejects the depth request.
    try {
        const all = await client.listMemberships(userDescriptor, GraphTraversalDirection.Up, MAX_MEMBERSHIP_DEPTH);
        return (all ?? []).some(m => targetDescriptors.has(m.containerDescriptor));
    } catch (e) {
        console.warn("groupCheck: transitive membership query failed, walking level by level", e);
    }

    const pending = [userDescriptor];
    const visited = new Set<string>();

    while (pending.length > 0) {
        const subjectDescriptor = pending.shift()!;
        // Defensive: an empty descriptor would build a URL with no {subjectDescriptor}
        // route segment, which the API 404s rather than rejecting outright.
        if (!subjectDescriptor || visited.has(subjectDescriptor)) {
            continue;
        }
        visited.add(subjectDescriptor);

        // Org-level groups (and Entra-backed groups) can reject membership listing for
        // the caller. Skip that branch rather than failing the whole check, so other
        // paths to the target group are still evaluated.
        let memberships: Awaited<ReturnType<GraphRestClient["listMemberships"]>>;
        try {
            memberships = await client.listMemberships(subjectDescriptor, GraphTraversalDirection.Up);
        } catch (e) {
            console.warn(`groupCheck: could not list memberships for ${subjectDescriptor}`, e);
            continue;
        }
        for (const membership of memberships) {
            if (targetDescriptors.has(membership.containerDescriptor)) {
                return true;
            }
            if (!visited.has(membership.containerDescriptor)) {
                pending.push(membership.containerDescriptor);
            }
        }
    }

    return false;
}
