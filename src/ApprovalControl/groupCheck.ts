import * as SDK from "azure-devops-extension-sdk";
import { getClient } from "azure-devops-extension-api";
import { CoreRestClient } from "azure-devops-extension-api/Core";
import { GraphRestClient, GraphSubject, GraphTraversalDirection } from "azure-devops-extension-api/Graph";

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
    const queries = [
        client.querySubjects({ query: groupName, subjectKind: ["Group"], scopeDescriptor: projectDescriptor }),
        client.querySubjects({ query: groupName, subjectKind: ["Group"], scopeDescriptor: "" })
    ];
    const results = await Promise.all(queries);
    const groups = new Map<string, GraphSubject>();
    for (const subject of results.flat()) {
        if (subject.displayName.toLowerCase() === groupName.toLowerCase()) {
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

        const memberships = await client.listMemberships(subjectDescriptor, GraphTraversalDirection.Up);
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
