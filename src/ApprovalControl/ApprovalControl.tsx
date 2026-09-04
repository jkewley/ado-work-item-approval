import * as React from "react";
import * as ReactDOM from "react-dom";
import * as SDK from "azure-devops-extension-sdk";
import {
    IWorkItemFormService,
    IWorkItemLoadedArgs,
    IWorkItemNotificationListener,
    WorkItemTrackingServiceIds
} from "azure-devops-extension-api/WorkItemTracking";

import { ApprovalButton, IControlConfig } from "./ApprovalButton";
import { startAutoResize } from "./autoResize";
import "./ApprovalControl.scss";

const container = document.getElementById("root")!;
let control: ApprovalButton | null = null;

function getFormService(): Promise<IWorkItemFormService> {
    return SDK.getService<IWorkItemFormService>(WorkItemTrackingServiceIds.WorkItemFormService);
}

/**
 * Control inputs configured by the process administrator in the form layout arrive on the
 * contribution configuration as `witInputs`.
 */
function readConfig(): IControlConfig | string {
    const inputs = (SDK.getConfiguration().witInputs ?? {}) as Record<string, string>;
    const groupName = (inputs.GroupName ?? "").trim();
    const approverField = (inputs.ApproverField ?? "").trim();
    const approvedOnField = (inputs.ApprovedOnField ?? "").trim();
    const approverTeam = (inputs.ApproverTeam ?? "").trim();
    const adminTeam = (inputs.AdminTeam ?? "").trim();
    const visibilityField = (inputs.VisibilityField ?? "").trim();
    const visibilityValue = (inputs.VisibilityValue ?? "").trim();

    if (!groupName) {
        return "This approval control has no group name. Edit the field in the form layout and set 'Group name'.";
    }
    if (!approverField) {
        return "This approval control has no approver field. Edit the field in the form layout and choose an identity field.";
    }

    return {
        groupName,
        approverField,
        approvedOnField: approvedOnField || undefined,
        approverTeam: approverTeam || undefined,
        adminTeam: adminTeam || undefined,
        visibilityField: visibilityField || undefined,
        visibilityValue: visibilityValue || undefined
    };
}

function renderError(message: string): void {
    ReactDOM.render(<div className="approval-control approval-control--error">{message}</div>, container);
}

const listener: IWorkItemNotificationListener = {
    onLoaded: (args: IWorkItemLoadedArgs) => {
        void control?.refresh({ readOnly: args.isReadOnly });
    },
    onFieldChanged: () => {
        // Refresh unconditionally: a work item rule may have changed the approver field
        // without it appearing in changedFields for this control.
        void control?.refresh();
    },
    onSaved: () => {
        void control?.refresh({ saved: true });
    },
    onRefreshed: () => {
        void control?.refresh();
    },
    onReset: () => {
        void control?.refresh();
    },
    onUnloaded: () => {
        /* nothing to tear down */
    }
};

async function main(): Promise<void> {
    await SDK.init({ loaded: false, applyTheme: true });
    await SDK.ready();

    const config = readConfig();
    if (typeof config === "string") {
        renderError(config);
        startAutoResize(container);
        SDK.register(SDK.getContributionId(), () => listener);
        await SDK.notifyLoadSucceeded();
        return;
    }

    ReactDOM.render(
        <ApprovalButton
            ref={instance => {
                control = instance;
            }}
            config={config}
            getFormService={getFormService}
        />,
        container
    );

    startAutoResize(container);
    SDK.register(SDK.getContributionId(), () => listener);
    await SDK.notifyLoadSucceeded();
}

void main();
