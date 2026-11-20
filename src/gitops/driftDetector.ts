/**
 * GitOps drift detector for comparing local/git repository stellar.toml
 * against live production web server versions.
 *
 * Detects configuration drift between the canonical Git repository and
 * live production deployments, enabling automated detection of:
 * - Uncommitted changes on production (out-of-band updates)
 * - Unreleased commits (changes merged to Git but not yet deployed)
 * - Precise semantic differences between repository and live state
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export type DriftSeverity = 'critical' | 'error' | 'warning' | 'info';
import type { Rule, Diagnostic } from '../types.js';

/** Default timeout for fetching live stellar.toml in milliseconds */
export const DEFAULT_FETCH_TIMEOUT = 10000;

/** Default Git path (relative to repo root) */
export const DEFAULT_GIT_PATH = 'stellar.toml';

/** Drift detection severity levels */

/**
 * Represents a single difference between repository and live state.
 */
export interface DriftFinding {
  /** The rule/category identifying this finding */
  rule: string;
  /** Severity of the drift */
  severity: DriftSeverity;
  /** Human-readable description */
  message: string;
  /** Suggestion for remediation */
  suggestion: string;
  /** Path in the source file where the issue was found */
  path?: string;
  /** The type of drift: 'uncommitted' or 'unreleased' */
  driftType: 'uncommitted' | 'unreleased';
}

/**
 * Result of GitOps drift detection.
 */
export interface DriftDetectionResult {
  /** True when repository and live state are in sync */
  inSync: boolean;
  /** Array of drift findings */
  findings: DriftFinding[];
  /** Summary text for reporting */
  summary: string;
  /** Git-style diff output */
  diffOutput: string;
  /** Structured JSON output */
  jsonOutput: string;
}

/**
 * Options for GitOps drift detection.
 */
export interface DriftDetectionOptions {
  /** Timeout in milliseconds for fetching live stellar.toml */
  fetchTimeout?: number;
  /** Path to the stellar.toml file in the Git repository */
  gitPath?: string;
  /** Domain of the live production stellar.toml */
  liveDomain?: string;
  /** Whether to perform colorized output */
  colorized?: boolean;
}

/**
 * Main class that detects GitOps deployment drift between Git repository
 * and live anchor domains.
 */
export class GitOpsDriftDetector {
  /** Detection options */
  private options: DriftDetectionOptions;

  /**
   * Creates a new GitOpsDriftDetector instance.
   * @param options Configuration options for the detector
   */
  constructor(options: DriftDetectionOptions = {}) {
    this.options = {
      fetchTimeout: DEFAULT_FETCH_TIMEOUT,
      gitPath: DEFAULT_GIT_PATH,
      liveDomain: undefined,
      colorized: true,
      ...options,
    };
  }

  /**
   * Fetches the live stellar.toml from the production domain.
   * @param domain The anchor domain to fetch from
   * @returns Parsed stellar.toml content or null on failure
   */
  async fetchLiveStellarToml(domain: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.fetchTimeout!);

      const response = await fetch(`https://${domain}/.well-known/stellar.toml`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/toml',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      return text;
    } catch {
      return null;
    }
  }

  /**
   * Parses a stellar.toml file content into a structured object.
   * @param content The stellar.toml file content
   * @returns Parsed content or null on failure
   */
  parseStellarToml(content: string): Record<string, unknown> | null {
    const parse = require("smol-toml");;;
    try {
      return parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Compares the repository stellar.toml against the live production version.
   * @param repoContent The repository stellar.toml content
   * @param liveContent The live stellar.toml content
   * @returns DriftDetectionResult with findings and diff
   */
  detectDrift(
    repoContent: string,
    liveContent: string
  ): DriftDetectionResult {
    const repoParsed = this.parseStellarToml(repoContent);
    const liveParsed = this.parseStellarToml(liveContent);

    const findings: DriftFinding[] = [];

    // If we can parse both, compare the structures
    if (repoParsed && liveParsed) {
      this.compareParsedObjects(repoParsed, liveParsed, findings);
    } else if (!repoParsed && liveParsed) {
      // Repository file can't be parsed, but live can
      findings.push({
        rule: 'drift/unparseable-repo',
        severity: 'error',
        message: 'Repository stellar.toml is unparseable',
        suggestion: 'Validate the repository stellar.toml format and ensure it follows SEP-1',
        driftType: 'uncommitted',
      });
    } else if (repoParsed && !liveParsed) {
      // Live file can't be parsed, but repo can
      findings.push({
        rule: 'drift/unparseable-live',
        severity: 'error',
        message: 'Live stellar.toml is unparseable',
        suggestion: 'Validate the production stellar.toml format and ensure it follows SEP-1',
        driftType: 'uncommitted',
      });
    } else {
      // Neither can be parsed - report as unparseable
      findings.push({
        rule: 'drift/unparseable-both',
        severity: 'error',
        message: 'Both repository and live stellar.toml are unparseable',
        suggestion: 'Validate both stellar.toml files follow SEP-1 format',
        driftType: 'uncommitted',
      });
    }

    const inSync = findings.length === 0;
    const summary = inSync
      ? 'No drift detected - repository and live state are in sync'
      : `Drift detected: ${findings.length} difference(s)`;

    // Generate diff output
    const diffOutput = this.generateDiffOutput(findings);

    // Generate JSON output
    const jsonOutput = this.generateJsonOutput(findings);

    return {
      inSync,
      findings,
      summary,
      diffOutput,
      jsonOutput,
    };
  }

  /**
   * Compares two parsed stellar.toml objects and finds differences.
   * @param repo The repository parsed stellar.toml
   * @param live The live parsed stellar.toml
   * @param findings Array to push drift findings to
   */
  private compareParsedObjects(
    repo: Record<string, unknown>,
    live: Record<string, unknown>,
    findings: DriftFinding[]
  ): void {
    const repoKeys = new Set(Object.keys(repo));
    const liveKeys = new Set(Object.keys(live));

    // Keys only in live (unreleased - deployed but not in repo, or out-of-band changes)
    for (const key of liveKeys) {
      if (!repoKeys.has(key)) {
        findings.push({
          rule: 'drift/new-key',
          severity: 'warning',
          message: `Live configuration has key '${key}' not present in repository`,
          suggestion: `Add key '${key}' to the repository stellar.toml or verify it is intentional`,
          driftType: 'unreleased',
        });
      }
    }

    // Keys only in repo (unreleased commits - in repo but not deployed)
    for (const key of repoKeys) {
      if (!liveKeys.has(key)) {
        findings.push({
          rule: 'drift/removed-key',
          severity: 'warning',
          message: `Repository has key '${key}' not present in live configuration`,
          suggestion: `Verify if key '${key}' should be removed from production or restored to repository`,
          driftType: 'unreleased',
        });
      }
    }

    // Compare values for keys present in both
    const commonKeys = new Set([...repoKeys].filter(x => liveKeys.has(x)));
    for (const key of commonKeys) {
      const repoValue = repo[key];
      const liveValue = live[key];

      if (typeof repoValue !== typeof liveValue) {
        findings.push({
          rule: 'drift/type-mismatch',
          severity: 'error',
          message: `Type mismatch for key '${key}': repo has ${typeof repoValue}, live has ${typeof liveValue}`,
          suggestion: `Verify the ${key} configuration type is consistent between repo and live`,
          driftType: 'unreleased',
        });
      } else if (typeof repoValue === 'string' && repoValue !== liveValue) {
        findings.push({
          rule: 'drift/value-mismatch',
          severity: 'error',
          message: `Value mismatch for key '${key}'`,
          suggestion: `Update ${key} in repository to match live: "${liveValue}"`,
          driftType: 'unreleased',
        });
      } else if (typeof repoValue === 'object' && repoValue !== null && liveValue !== null) {
        // Recursively compare nested objects
        this.compareParsedObjects(
          repoValue as Record<string, unknown>,
          liveValue as Record<string, unknown>,
          findings
        );
      }
    }
  }

  /**
   * Generates a git-style diff output from the findings.
   * @param findings Array of drift findings
   * @returns Git-style diff string
   */
  private generateDiffOutput(findings: DriftFinding[]): string {
    if (findings.length === 0) {
      return 'No drift detected.\n';
    }

    let output = '--- a/stellar.toml\t\t\t\t\t\t\t\t\t\t\t\t  2024-01-01 00:00:00 +0000\n';
    output += '+++ b/stellar.toml\t\t\t\t\t\t\t\t\t\t\t\t  2024-01-01 00:00:00 +0000\n';

    const uncommittedFindings = findings.filter(f => f.driftType === 'uncommitted');
    const unreleasedFindings = findings.filter(f => f.driftType === 'unreleased');

    if (uncommittedFindings.length > 0) {
      output += `@@ -0,0 +1,${uncommittedFindings.length} @@\n`;
      output += `+Uncommitted changes on production (out-of-band updates):\n`;
      for (const finding of uncommittedFindings) {
        output += `+ ${finding.message}\n`;
      }
    }

    if (unreleasedFindings.length > 0) {
      output += `@@ -0,0 +1,${unreleasedFindings.length} @@\n`;
      output += `+Unreleased commits (in Git but not deployed):\n`;
      for (const finding of unreleasedFindings) {
        output += `+ ${finding.message}\n`;
      }
    }

    return output;
  }

  /**
   * Generates structured JSON output from the findings.
   * @param findings Array of drift findings
   * @returns JSON string
   */
  private generateJsonOutput(findings: DriftFinding[]): string {
    if (findings.length === 0) {
      return JSON.stringify({ inSync: true, findings: [] });
    }

    const findingsArray = findings.map(finding => ({
      rule: finding.rule,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion,
      driftType: finding.driftType,
    }));

    return JSON.stringify({ inSync: false, findings: findingsArray });
  }

  /**
   * Full drift detection workflow: fetch live stellar.toml and compare with repo.
   * @param domain The live production domain
   * @param gitPath Path to stellar.toml in the Git repository (relative to repo root)
   * @returns DriftDetectionResult with all findings
   */
  async detectFullDrift(
    domain: string,
    gitPath: string = this.options.gitPath!
  ): Promise<DriftDetectionResult> {
    // Read the repository stellar.toml
    let repoContent: string;
    try {
      repoContent = await readFile(join(process.cwd(), gitPath), 'utf8');
    } catch {
      // If file doesn't exist in current directory, try parent
      try {
        repoContent = await readFile(gitPath, 'utf8');
      } catch {
        repoContent = '';
      }
    }

    // Fetch the live stellar.toml
    let liveContent: string | null = null;
    if (this.options.liveDomain || domain) {
      const liveDomain = this.options.liveDomain || domain;
      liveContent = await this.fetchLiveStellarToml(liveDomain);
    }

    // Detect drift
    const result = this.detectDrift(repoContent, liveContent ?? '');

    // Enhance summary with domain info
    result.summary += ` (comparing ${this.options.gitPath ?? DEFAULT_GIT_PATH} vs https://${domain ?? this.options.liveDomain ?? 'unknown'}/.well-known/stellar.toml)`;

    return result;
  }
}

/**
 * Creates a default GitOpsDriftDetector instance configured for production use.
 */
export function createDefaultDriftDetector(): GitOpsDriftDetector {
  return new GitOpsDriftDetector();
}

/**
 * Creates a GitOpsDriftDetector instance configured for a specific domain.
 * @param domain The live production domain to compare against
 * @returns Configured drift detector instance
 */
export function createDomainDriftDetector(domain: string): GitOpsDriftDetector {
  return new GitOpsDriftDetector({
    liveDomain: domain,
  });
}

/** Rule IDs for drift detection findings. */
export const DRIFT_RULE_IDS = {
  /** Key present in live but not in repo */
  NEW_KEY: 'drift/new-key',
  /** Key present in repo but not in live */
  REMOVED_KEY: 'drift/removed-key',
  /** Type mismatch between repo and live */
  TYPE_MISMATCH: 'drift/type-mismatch',
  /** Value mismatch between repo and live */
  VALUE_MISMATCH: 'drift/value-mismatch',
  /** Unparseable repository stellar.toml */
  UNPARSABLE_REPO: 'drift/unparseable-repo',
  /** Unparseable live stellar.toml */
  UNPARSABLE_LIVE: 'drift/unparseable-live',
  /** Unparseable both */
  UNPARSABLE_BOTH: 'drift/unparseable-both',
};

/** Registered drift detection rules for --list-rules and --off/--warn/--error. */
export const driftRules: Rule[] = [
  {
    id: DRIFT_RULE_IDS.NEW_KEY,
    category: 'network',
    severity: 'warning',
    description: 'Live stellar.toml has keys not present in the repository',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.REMOVED_KEY,
    category: 'network',
    severity: 'warning',
    description: 'Repository has keys not present in the live stellar.toml',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.TYPE_MISMATCH,
    category: 'network',
    severity: 'error',
    description: 'Type mismatch for a configuration key between repo and live',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.VALUE_MISMATCH,
    category: 'network',
    severity: 'error',
    description: 'Value mismatch for a configuration key between repo and live',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.UNPARSABLE_REPO,
    category: 'network',
    severity: 'error',
    description: 'Repository stellar.toml is unparseable',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.UNPARSABLE_LIVE,
    category: 'network',
    severity: 'error',
    description: 'Live stellar.toml is unparseable',
    run() {},
  },
  {
    id: DRIFT_RULE_IDS.UNPARSABLE_BOTH,
    category: 'network',
    severity: 'error',
    description: 'Both repository and live stellar.toml are unparseable',
    run() {},
  },
];

