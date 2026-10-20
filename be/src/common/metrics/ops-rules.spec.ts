import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { HTTP_LABELS, registry } from './metrics';

/**
 * B7.2 Task 3 (Q-37.3, no promtool here): the shipped alert rules, their promtool tests and the
 * Grafana dashboard may only reference metrics, label names and label values that the app really
 * exports (checked against the live registry output, which holds every finite series at 0, M4).
 */
const OPS = join(process.cwd(), '..', 'ops');
const read = (p: string) => readFileSync(join(OPS, p), 'utf8');

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
const alerts = parse(read('prometheus/alerts.yml')) as {
  groups: { name: string; rules: Rule[] }[];
};
const rules = alerts.groups.flatMap((g) => g.rules);
const promtoolTests = parse(read('prometheus/alerts.test.yml')) as {
  rule_files: string[];
  tests: {
    input_series: { series: string; values: string }[];
    alert_rule_test: {
      alertname: string;
      exp_alerts: { exp_labels: Record<string, string>; exp_annotations: Record<string, string> }[];
    }[];
  }[];
};
const dashboard = JSON.parse(read('grafana/dashboard.json')) as {
  panels: { title: string; targets: { expr: string }[] }[];
};

const KEYWORDS = new Set([
  'by',
  'without',
  'and',
  'or',
  'unless',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'offset',
]);
const BASE_SUFFIX = /_(count|sum|bucket)$/;

/** Metric names an expression selects (functions, keywords, label lists and ranges removed). */
function metricNames(expr: string): string[] {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  return [...stripped.matchAll(/([a-zA-Z_:][\w:]*)(\s*\()?/g)]
    .filter((m) => !m[2] && !KEYWORDS.has(m[1]))
    .map((m) => m[1]);
}

/** `{k op "v"}` matchers of every selector in an expression. */
function matchers(expr: string): { metric: string; label: string; op: string; value: string }[] {
  const out: { metric: string; label: string; op: string; value: string }[] = [];
  for (const sel of expr.matchAll(/([a-zA-Z_:][\w:]*)\s*\{([^}]*)\}/g)) {
    for (const m of sel[2].matchAll(/(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)) {
      out.push({ metric: sel[1], label: m[1], op: m[2], value: m[3] });
    }
  }
  return out;
}

const allExprs = [
  ...rules.map((r) => ({ where: `rule ${r.alert}`, expr: r.expr })),
  ...dashboard.panels.flatMap((p) =>
    p.targets.map((t) => ({ where: `panel "${p.title}"`, expr: t.expr })),
  ),
];

describe('ops/prometheus + ops/grafana vs the exported metrics (B7.2 Task 3)', () => {
  let exported: Map<string, Record<string, string | number>[]>;

  beforeAll(async () => {
    exported = new Map(
      (await registry.getMetricsAsJSON()).map((m) => [
        m.name,
        m.values.map((v) => v.labels as Record<string, string | number>),
      ]),
    );
  });

  it('alerts.yml: one group sso-idp; every rule has alert, expr, labels.severity, annotations.summary', () => {
    expect(alerts.groups.map((g) => g.name)).toEqual(['sso-idp']);
    expect(rules.map((r) => r.alert).sort()).toEqual([
      'SsoEmergencyKeyRotation',
      'SsoHttp5xxRatioHigh',
      'SsoTokenErrorRatioHigh',
      'SsoTokenReuseDetected',
    ]);
    for (const r of rules) {
      expect(r.expr).toEqual(expect.any(String));
      expect(['critical', 'warning']).toContain(r.labels?.severity);
      expect(r.annotations?.summary).toEqual(expect.any(String));
      // No label templating in annotations (nothing identifying can leak into a notification).
      expect(JSON.stringify(r.annotations)).not.toMatch(/\{\{|\$labels|\$value/);
      // Multi-instance safe: every selector is aggregated.
      expect(r.expr).toMatch(/^sum\(/);
    }
  });

  it('dashboard.json has >= 4 panels, each with at least one PromQL target', () => {
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(4);
    for (const p of dashboard.panels) expect(p.targets.length).toBeGreaterThan(0);
  });

  it.each(allExprs)('$where: every metric it selects is exported by the app', ({ expr }) => {
    const names = metricNames(expr);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect([...exported.keys()]).toContain(name.replace(BASE_SUFFIX, ''));
  });

  it.each(allExprs)('$where: every label matcher names a real label and value', ({ expr }) => {
    for (const { metric, label, op, value } of matchers(expr)) {
      const base = metric.replace(BASE_SUFFIX, '');
      const series = exported.get(base);
      expect(series).toBeDefined();
      if (base === 'sso_http_request_duration_seconds') {
        // Histogram series only appear once a request was served: check the label set and shape.
        expect([...HTTP_LABELS, 'le']).toContain(label);
        if (label === 'status_class') expect(value).toMatch(/^[1-5]xx$/);
        if (label === 'route') expect(value).toMatch(/^(\/|__unmatched$)/);
        continue;
      }
      expect(series!.some((s) => label in s)).toBe(true);
      if (op === '=' || op === '=~') {
        for (const alt of op === '=' ? [value] : value.split('|')) {
          expect(series!.some((s) => String(s[label]) === alt)).toBe(true);
        }
      }
    }
  });

  it('alerts.test.yml targets alerts.yml, tests only existing alerts, and expects the exact annotations', () => {
    expect(promtoolTests.rule_files).toEqual(['alerts.yml']);
    const byName = new Map(rules.map((r) => [r.alert, r]));
    const tested = new Set<string>();
    for (const t of promtoolTests.tests) {
      for (const a of t.alert_rule_test) {
        const rule = byName.get(a.alertname);
        expect(rule).toBeDefined();
        tested.add(a.alertname);
        for (const exp of a.exp_alerts) {
          expect(exp.exp_labels).toEqual(rule!.labels);
          expect(exp.exp_annotations).toEqual(rule!.annotations);
        }
      }
      for (const s of t.input_series) {
        const name = /^([a-zA-Z_:][\w:]*)/.exec(s.series)![1];
        expect([...exported.keys()]).toContain(name.replace(BASE_SUFFIX, ''));
      }
    }
    expect([...tested].sort()).toEqual([...byName.keys()].sort());
    // Each alert has at least one firing and one silent case.
    for (const name of byName.keys()) {
      const cases = promtoolTests.tests
        .flatMap((t) => t.alert_rule_test)
        .filter((a) => a.alertname === name);
      expect(cases.some((c) => c.exp_alerts.length > 0)).toBe(true);
      expect(cases.some((c) => c.exp_alerts.length === 0)).toBe(true);
    }
  });
});
