import { getCapabilityReport, runDryRunProbe } from './st-context.js';

export async function runDiagnostics(context) {
    const capabilities = getCapabilityReport(context);
    const dryRun = await runDryRunProbe(context);

    return {
        timestamp: new Date().toISOString(),
        capabilities,
        dryRun,
        startEnabled: capabilities.hasContext
            && capabilities.hasEventSource
            && capabilities.hasGenerate
            && capabilities.requiredEvents.every((item) => item.present),
    };
}
