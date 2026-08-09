"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envConfig = envConfig;
const AGENT_SIZES_DEV = {
    aria: { cpu: 256, memoryMiB: 512, minCount: 1, maxCount: 4 },
    atlas: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 4 },
    // Sentinel holds long-lived stream connections, so it gets real memory and
    // scales to zero when nothing is being watched — it is the expensive agent.
    sentinel: { cpu: 1024, memoryMiB: 2048, minCount: 0, maxCount: 3 },
    archivist: { cpu: 256, memoryMiB: 512, minCount: 1, maxCount: 4 },
};
const AGENT_SIZES_PROD = {
    aria: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 12 },
    atlas: { cpu: 1024, memoryMiB: 2048, minCount: 1, maxCount: 10 },
    sentinel: { cpu: 2048, memoryMiB: 4096, minCount: 0, maxCount: 6 },
    archivist: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 8 },
};
function envConfig(envName, alertEmail) {
    const base = {
        envName,
        evidenceRetentionYears: 7,
        alertEmail,
    };
    if (envName === 'prod') {
        return {
            ...base,
            natGateways: 2,
            auroraMinAcu: 0.5,
            auroraMaxAcu: 16,
            auroraMultiAz: true,
            auroraBackupRetentionDays: 30,
            useFargateSpot: false,
            orchestrator: { cpu: 1024, memoryMiB: 2048, minCount: 2, maxCount: 10 },
            agents: AGENT_SIZES_PROD,
            logRetentionDays: 90,
            monthlyBudgetUsd: 500,
            removalProtection: true,
        };
    }
    return {
        ...base,
        natGateways: 1,
        auroraMinAcu: 0.5,
        auroraMaxAcu: 4,
        auroraMultiAz: false,
        auroraBackupRetentionDays: 7,
        useFargateSpot: true,
        orchestrator: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 4 },
        agents: AGENT_SIZES_DEV,
        logRetentionDays: 14,
        monthlyBudgetUsd: envName === 'staging' ? 200 : 75,
        removalProtection: false,
    };
}
