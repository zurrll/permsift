import type { Scenario } from '../config.js';
import type { Check } from '../assertions.js';
import type { Comparable } from '../usage-report.js';

/** Missing data is a fact about retention/declaration, never an empty result. */
export type MissingState = 'not_saved' | 'not_declared' | 'not_run';
export type Saved<T> = { state: 'recorded'; value: T } | { state: MissingState; reason: string };
export type Verdict = 'pass' | 'fail' | 'unknown';
export type Evaluation = { status: Verdict | 'not_saved' | 'not_run'; basis: string };
export type CaptureStatus = 'captured' | 'incomplete' | 'unavailable' | 'not_collected' | 'not_saved' | 'not_run';
export type Capture = { status: CaptureStatus; issues: string[]; scope: string };

/** key is logical continuity within a project; id identifies retained definition content. */
export type TaskDefinition = {
  id: string; key: string;
  definition: Saved<{ command: string[]; success_conditions: Scenario['assertions'] }>;
};
export type ProtectionGoal = {
  key: string; target: string; target_kind: 'file' | 'directory';
  operation: 'read' | 'create' | 'write'; stage: 'install' | 'task'; expected: 'denied';
};
/** This round only imports not_declared from legacy producers; it executes no new goals. */
export type ProtectionAgreement = { id: string; task_key: string; declaration: Saved<ProtectionGoal[]> };
export type ReadPolicy = {
  mode: 'legacy' | 'explicit'; grants: string[];
  target_kinds: Saved<Record<string, 'file' | 'directory'>>;
};
export type PolicyPlan = {
  id: string; task_key: string; scope: 'producer_variable_grants';
  task: { write: Saved<string[]>; read: Saved<ReadPolicy>; network: Saved<string[]> };
  installation: Saved<{
    mode: 'shared' | 'separate'; write: string[]; network: Saved<string[]>;
    reads: 'producer_fixed_workspace_reads';
  }>;
};
export type ProcessFact = { status: string; exit_code: number | null };
export type BoundaryStage = {
  stage: 'before' | 'after_installation' | 'before_offline_task' | 'after';
  checks: Check[];
};
export type ExecutionConditions = {
  input_hash: Saved<string>; config_hash: Saved<string>; limits_hash: Saved<string>;
  environment: Saved<Record<string, string>>;
  preparation: Saved<string[]>;
  requirements: Saved<{ timeout_seconds: number; install: Record<string, unknown> | null }>;
  producer_scenario_hash: Saved<string>;
  actual_command: Saved<string[]>;
  instrumentation: Saved<Record<string, unknown>>;
  installation_state: Saved<{ reused: boolean; snapshot: Saved<Record<string, unknown>> }>;
  producer_policy_hash: Saved<string>;
};
export type ObservationFacts = {
  inventory: Capture; modules: Capture; compiler: Capture; build: Capture;
  /** The producer's independently validated source records; no role/necessity inference. */
  records: Saved<Comparable['tasks'][number]>;
};
export type ExecutionEvidence = {
  id: string; task_id: string; agreement_id: string; policy_id: Saved<string>;
  origin: { producer_id: string; record: string; phase: string };
  reported_verdict: Saved<Verdict>;
  process: Saved<ProcessFact>; assertions: Saved<Check[]>;
  installation: Saved<{ command: string[]; process: ProcessFact; reported_verdict: Verdict; reused: Saved<boolean> }>;
  boundaries: Saved<BoundaryStage[]>;
  observations: ObservationFacts;
  conditions: ExecutionConditions;
  outcomes: { task: Evaluation; boundaries: Evaluation };
};
/** A legacy check reference records comparison selection, not long-term adoption. */
export type BaselineReference = {
  id: string; selection: 'comparison_reference';
  producer_reference: string; adoption: 'not_recorded';
  resolution: 'not_loaded'; task_ids: string[];
};
export type Workflow = {
  kind: 'run' | 'tighten' | 'doctor' | 'observe' | 'check';
  reported_status: string;
  verification: Saved<{ baseline_verified: boolean; final_verified: boolean }>;
  search_complete: Saved<boolean>;
  current_policies: { task_key: string; policy_id: string }[];
  searches: { task_key: string; permission: string; stop: string; decisions: string[];
    steps: { decision: string; operation: Saved<string>; before: Saved<string[]>; after: Saved<string[]>;
      semantic_change: Saved<boolean>; trial_id: Saved<string>; recovery_id: Saved<string> }[] }[];
  comparisons: {
    task_key: string; reported_status: string; definition_changed: Saved<boolean>;
    reason: Saved<string>; repair_stop: Saved<string>;
    stages: { phase: string; reported_verdict: Verdict; report: string; trials: number; preparation: string[] }[];
    suggestion_policy: Saved<string>; suggestion_verified: Saved<boolean>;
  }[];
  review_reasons: string[];
};
export type LegacySource = {
  format: 'experiment-v1' | 'usage-v1' | 'regression-v1';
  artifact_hash: string; producer_version: Saved<string>;
  environment: Saved<Record<string, string>>;
  recorded_hashes: { config: Saved<string>; limits: Saved<string>; input: Saved<string> };
  inputs_status: 'not_saved' | 'matched';
  evidence_records: { path: string; artifact_hash: string }[];
};
export type Model = {
  model_version: 1; identity_version: 1;
  source: LegacySource;
  tasks: TaskDefinition[]; agreements: ProtectionAgreement[]; policies: PolicyPlan[];
  executions: ExecutionEvidence[]; baselines: BaselineReference[];
  workflow: Workflow;
};

export type ComparisonState = 'same' | 'changed' | 'not_saved' | 'not_declared';
export type ModelComparison = {
  input: ComparisonState; limits: ComparisonState; environment: ComparisonState;
  tasks: {
    key: string; presence: 'both' | 'added' | 'removed';
    definition: ComparisonState; agreement: ComparisonState; policies: ComparisonState;
    execution_conditions: ComparisonState;
    legacy_scenario_fingerprint: ComparisonState;
    /** No universal "old agreement preserved" conclusion is inferred here. */
    review_reasons: string[];
  }[];
};
