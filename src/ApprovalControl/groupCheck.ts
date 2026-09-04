import * as SDK from "azure-devops-extension-sdk";
import { getClient } from "azure-devops-extension-api";
import { CoreRestClient } from "azure-devops-extension-api/Core";

const cache = new Map<string, Promise<boolean>>();

/**
 * True when the signed-in user is a member of the ADO team whose name matches
 * teamName (case-insensitive) in the current project.
 *
 * Uses CoreRestClient.getTeams(mine: true) rather than the Graph API, because
 * the Graph API lives on vssps.dev.azure.com which blocks CORS requests from
 * extension iframe origins. The Core API lives on dev.azure.com and works fine.
 *
 * Limitation: matches ADO Teams only, not arbitrary security groups.
 * Fails closed on any API error. Cached for the iframe lifetime.
 */
export function isCurrentUserInTeam(teamName: string): Promise<boolean> {
    const key = teamName.toLowerCase();
    if (!cache.has(key)) {
        const p = resolve(teamName).catch(() => false);
        cache.set(key, p);
    }
    return cache.get(key)!;
}

async function resolve(teamName: string): Promise<boolean> {
    const projectId = SDK.getPageContext().webContext.project.id;
    const client = getClient(CoreRestClient);
    const needle = teamName.toLowerCase();
    const pageSize = 100;
    let skip = 0;
    while (true) {
        const page = await client.getTeams(projectId, /* mine */ true, pageSize, skip);
        if (page.some(t => t.name.toLowerCase() === needle)) {
            return true;
        }
        if (page.length < pageSize) {
            return false;
        }
        skip += pageSize;
    }
}
