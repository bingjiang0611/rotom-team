/**
 * What the controlled benchmarks do and which numbers they report. The ledger (`ledger.json`) keys each number by
 * scenario/metric and records the workload text below: a number measured under another workload is another number,
 * so changing a workload means registering new keys, never reusing old ones.
 */
export { SEND_NETWORK, SPLIT_FIRST_OUTPUT_MS, WORKLOAD } from "./workload-base.ts";
export { SCENARIOS } from "./workload-scenarios.ts";
export {
    metricSpec,
    REPORTED,
    type Layer,
    type MetricSpec,
    type Unit,
} from "./workload-metrics.ts";
