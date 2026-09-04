import * as React from "react";
import * as SDK from "azure-devops-extension-sdk";
import { Button } from "azure-devops-ui/Button";
import { IWorkItemFormService } from "azure-devops-extension-api/WorkItemTracking";

import { isCurrentUserInTeam } from "./groupCheck";
import { ApproverIdentity, formatIdentity, isSameIdentity, parseIdentity } from "./identity";

export interface IControlConfig {
    groupName: string;
    approverField: string;
    approvedOnField?: string;
    /** Display name of the ADO team whose members may approve. Absent = anyone. */
    approverTeam?: string;
    /** Display name of the ADO team whose members may reset anyone's approval. Absent = approver only. */
    adminTeam?: string;
    /** Field reference name to check for visibility, e.g. Custom.ReleaseType. Absent = always visible. */
    visibilityField?: string;
    /** Value that visibilityField must equal (case-insensitive) for the control to be shown. */
    visibilityValue?: string;
}

export interface IApprovalButtonProps {
    config: IControlConfig;
    /** Resolves the host's work item form service. */
    getFormService: () => Promise<IWorkItemFormService>;
}

interface IApprovalButtonState {
    loading: boolean;
    visible: boolean;
    approver?: ApproverIdentity;
    approvedOn?: Date;
    isAdmin: boolean;
    isInTeam: boolean;
    isReadOnly: boolean;
    /** The approval was written to the form but the work item has not been saved yet. */
    pendingSave: boolean;
    error?: string;
}

export class ApprovalButton extends React.Component<IApprovalButtonProps, IApprovalButtonState> {
    public state: IApprovalButtonState = {
        loading: true,
        visible: true,
        isAdmin: false,
        isInTeam: true,
        isReadOnly: false,
        pendingSave: false
    };

    public componentDidMount(): void {
        void this.refresh();
    }

    /** Re-reads field values from the form. Called by the work item notification listener. */
    public async refresh(options?: { readOnly?: boolean; saved?: boolean }): Promise<void> {
        try {
            const { approverField, approvedOnField, approverTeam, adminTeam, visibilityField, visibilityValue } = this.props.config;
            const service = await this.props.getFormService();

            const fields = [
                approverField,
                ...(approvedOnField ? [approvedOnField] : []),
                ...(visibilityField ? [visibilityField] : [])
            ];
            const [values, isInTeam, isAdmin] = await Promise.all([
                service.getFieldValues(fields),
                approverTeam ? isCurrentUserInTeam(approverTeam) : Promise.resolve(true),
                adminTeam ? isCurrentUserInTeam(adminTeam) : Promise.resolve(false)
            ]);

            const approver = parseIdentity(values[approverField]);
            const rawDate = approvedOnField ? values[approvedOnField] : undefined;
            const visible = visibilityField && visibilityValue
                ? String(values[visibilityField] ?? "").toLowerCase() === visibilityValue.toLowerCase()
                : true;

            this.setState(previous => ({
                loading: false,
                visible,
                approver,
                approvedOn: toDate(rawDate),
                isAdmin,
                isInTeam,
                isReadOnly: options?.readOnly ?? previous.isReadOnly,
                // A save commits whatever is on the form; a cleared field is no longer pending.
                pendingSave: options?.saved || !approver ? false : previous.pendingSave,
                error: undefined
            }));
        } catch (error) {
            this.setState({ loading: false, error: describe(error) });
        }
    }

    public setReadOnly(isReadOnly: boolean): void {
        this.setState({ isReadOnly });
    }

    public render(): JSX.Element | null {
        const { groupName, approverTeam } = this.props.config;
        const { loading, visible, approver, approvedOn, isAdmin, isInTeam, isReadOnly, pendingSave, error } = this.state;

        if (!visible) {
            return null;
        }

        if (error) {
            return <div className="approval-control approval-control--error">{error}</div>;
        }

        const currentUser = currentUserIdentity();
        const isApprover = isSameIdentity(approver, currentUser);
        const canReset = !!approver && !isReadOnly && (isApprover || isAdmin);
        const canApprove = isInTeam;
        const disabled = loading || isReadOnly || (!!approver && !canReset) || (!approver && !canApprove);
        const state = approvalState(approver, canReset, pendingSave);
        const label = buttonText(state, groupName, approver);

        return (
            <div className="approval-control">
                <Button
                    className={`approval-control__button approval-control__button--${state}`}
                    // The platform's own error-red and info-blue button treatments. ADO's
                    // --status-info-foreground and --communication-background are the same
                    // color, so `primary` is the info blue. Using the props rather than
                    // CSS keeps the hover, active, focus and high-contrast handling.
                    danger={state === "pending"}
                    primary={state === "reset"}
                    disabled={disabled}
                    text={label}
                    ariaLabel={buttonAriaLabel(state, label, approver, approvedOn, groupName)}
                    onClick={approver ? this.onReset : this.onApprove}
                />
                {state === "unsaved" && (
                    <div className="approval-control__caption approval-control__caption--unsaved">
                        Save the work item to record your approval
                    </div>
                )}
                {approver && state !== "unsaved" && (
                    <div className="approval-control__caption">
                        {captionText(state, approver, approvedOn, groupName)}
                    </div>
                )}
                {!canApprove && !approver && (
                    <div className="approval-control__caption">
                        Restricted to {approverTeam || "a specific team"}
                    </div>
                )}
            </div>
        );
    }

    private onApprove = async (): Promise<void> => {
        const identity = currentUserIdentity();
        await this.write(formatIdentity(identity), new Date());
    };

    private onReset = async (): Promise<void> => {
        await this.write(null, null);
    };

    private async write(approverValue: string | null, approvedOn: Date | null): Promise<void> {
        try {
            const { approverField, approvedOnField } = this.props.config;
            const service = await this.props.getFormService();

            await service.setFieldValue(approverField, approverValue as unknown as Object);
            if (approvedOnField) {
                await service.setFieldValue(approvedOnField, approvedOn as unknown as Object);
            }

            // Read back rather than trusting our own write: work item rules may have
            // rejected or rewritten the value.
            await this.refresh();
            this.setState({ pendingSave: approverValue !== null });
        } catch (error) {
            this.setState({ error: describe(error) });
        }
    }
}

/**
 * The single source of truth for what the control is showing. Both the label and the
 * color derive from this, so they can never disagree about which state we are in.
 *
 *  - `pending`  no approval recorded                     error   (red)
 *  - `unsaved`  approved on the form, not yet saved      warning (amber)
 *  - `reset`    recorded, and this user may clear it     info    (blue)
 *  - `approved` recorded, and this user may not clear it success (light green)
 *
 * `unsaved` outranks `reset` because until the work item is saved nothing is actually
 * recorded, which is the more important thing to tell the user.
 */
type ApprovalState = "pending" | "unsaved" | "reset" | "approved";

function approvalState(
    approver: ApproverIdentity | undefined,
    canReset: boolean,
    pendingSave: boolean
): ApprovalState {
    if (!approver) {
        return "pending";
    }
    if (pendingSave) {
        return "unsaved";
    }
    return canReset ? "reset" : "approved";
}

function buttonText(
    state: ApprovalState,
    groupName: string,
    approver: ApproverIdentity | undefined
): string {
    switch (state) {
        case "pending":
            return `Approve for ${groupName}`;
        case "unsaved":
            return `${groupName} : Pending`;
        case "reset":
            return "Reset Approval";
        case "approved":
            // `approver` is always set in this state; the fallback is only for the type.
            return approver ? approver.displayName : "Approved";
    }
}

/**
 * What a screen reader announces. In the `approved` state the visible label is just a
 * person's name, which says nothing about what the button is for, so the full sentence is
 * given here instead.
 */
function buttonAriaLabel(
    state: ApprovalState,
    label: string,
    approver: ApproverIdentity | undefined,
    approvedOn: Date | undefined,
    groupName: string
): string {
    if (state === "approved" && approver) {
        return `${approver.displayName} for ${groupName}${formatWhen(approvedOn)}`;
    }
    return label;
}

function captionText(
    state: ApprovalState,
    approver: ApproverIdentity,
    approvedOn: Date | undefined,
    groupName: string
): string {
    // In the `approved` state the approver's name is already the button label, so it is
    // not repeated here.
    return state === "approved"
        ? `Approved for ${groupName}${formatWhen(approvedOn)}`
        : `${approver.displayName} for ${groupName}${formatWhen(approvedOn)}`;
}

/** Empty when no "approved on" field is configured, so the phrase still reads. */
function formatWhen(approvedOn: Date | undefined): string {
    return approvedOn ? ` on ${approvedOn.toLocaleDateString()}` : "";
}

function currentUserIdentity(): ApproverIdentity {
    const user = SDK.getUser();
    return { id: user.id, displayName: user.displayName, uniqueName: user.name };
}

function toDate(value: unknown): Date | undefined {
    if (value instanceof Date) {
        return value;
    }
    if (typeof value === "string" && value.length > 0) {
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? undefined : parsed;
    }
    return undefined;
}

function describe(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : "Unexpected error in the approval control.";
}
