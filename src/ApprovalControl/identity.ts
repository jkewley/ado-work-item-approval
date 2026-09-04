/**
 * Identity fields on the work item form come back in more than one shape depending on
 * the ADO version and how the value was written: either an IdentityRef-like object, or
 * the legacy "Display Name <unique.name@contoso.com>" string. Normalize both.
 */
export interface ApproverIdentity {
    /** Identity GUID. Absent when the form hands us the legacy string form. */
    id?: string;
    displayName: string;
    /** UPN / email / domain qualified account name. */
    uniqueName?: string;
}

const LEGACY_FORMAT = /^\s*(.*?)\s*<([^>]+)>\s*$/;

export function parseIdentity(value: unknown): ApproverIdentity | undefined {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }

    if (typeof value === "string") {
        const match = LEGACY_FORMAT.exec(value);
        if (match) {
            return { displayName: match[1], uniqueName: match[2] };
        }
        return { displayName: value.trim() };
    }

    if (typeof value === "object") {
        const ref = value as Record<string, unknown>;
        const displayName = asString(ref.displayName) ?? asString(ref.name);
        if (!displayName) {
            return undefined;
        }
        return {
            id: asString(ref.id) ?? asString(ref.localId),
            displayName,
            uniqueName: asString(ref.uniqueName) ?? asString(ref.mailAddress) ?? asString(ref.signInAddress)
        };
    }

    return undefined;
}

/**
 * Value to write back to the identity field. The form's identity resolver accepts the
 * "Display Name <unique name>" form and resolves it to a full identity on save.
 */
export function formatIdentity(identity: ApproverIdentity): string {
    return identity.uniqueName ? `${identity.displayName} <${identity.uniqueName}>` : identity.displayName;
}

/**
 * Prefer matching on identity GUID; fall back to unique name, then display name, because
 * a value written by an older revision may not carry an id.
 */
export function isSameIdentity(a: ApproverIdentity | undefined, b: ApproverIdentity | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    if (a.id && b.id) {
        return equalsIgnoreCase(a.id, b.id);
    }
    if (a.uniqueName && b.uniqueName) {
        return equalsIgnoreCase(a.uniqueName, b.uniqueName);
    }
    return equalsIgnoreCase(a.displayName, b.displayName);
}

function equalsIgnoreCase(a: string, b: string): boolean {
    return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
