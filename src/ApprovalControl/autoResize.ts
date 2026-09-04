import * as SDK from "azure-devops-extension-sdk";

/**
 * Keeps the host iframe sized to the control's content.
 *
 * The `height` in the contribution manifest is only an initial value. The control grows
 * when the approval caption appears (and again when the "save the work item" hint is
 * added), so without this the iframe keeps its original height and the extra content
 * becomes an inner scrollbar.
 */
export function startAutoResize(element: HTMLElement): void {
    let lastHeight = -1;
    let queued = false;

    const publish = () => {
        queued = false;
        // Round up: a fractional content height truncates to a scrollbar.
        const height = Math.ceil(element.getBoundingClientRect().height);
        if (height > 0 && height !== lastHeight) {
            lastHeight = height;
            SDK.resize(undefined, height);
        }
    };

    // Coalesce the burst of mutations a React render produces into one resize.
    const schedule = () => {
        if (!queued) {
            queued = true;
            requestAnimationFrame(publish);
        }
    };

    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(schedule).observe(element);
    } else {
        // Fallback for hosts without ResizeObserver; cheap enough at this interval.
        window.setInterval(schedule, 500);
    }

    schedule();
}
