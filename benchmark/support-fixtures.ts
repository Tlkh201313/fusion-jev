export interface SupportFixture {
  id: string;
  kind: 'file' | 'command';
  task: string;
  path?: string;
  content?: string;
  expectedStdout: string;
  expectedStderr: string;
  expectedExit: number;
  diagnosticTruth: 'error' | 'none';
  approvedArgv: string[];
  qualityRubric: string;
}

export const supportFixtures: SupportFixture[] = [
  {
    id: 'unicode-source', kind: 'file', task: 'Recover the exact Unicode source line', path: 'note.txt',
    content: 'export const marker = "café 漢字 🔬";\n',
    expectedStdout: 'export const marker = "café 漢字 🔬";\n', expectedStderr: '',
    expectedExit: 0, diagnosticTruth: 'none',
    approvedArgv: [process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', 'note.txt'],
    qualityRubric: 'Exact source span recovered with no omitted bytes.',
  },
  {
    id: 'failing-check', kind: 'command', task: 'Capture a failed check without treating its text as a pass',
    expectedStdout: '', expectedStderr: 'file.ts(3,4): error TS2345: expected string, received number\n',
    expectedExit: 1, diagnosticTruth: 'error',
    approvedArgv: [process.execPath, '-e', 'process.stderr.write("file.ts(3,4): error TS2345: expected string, received number\\n"); process.exitCode = 1'],
    qualityRubric: 'Diagnostic bytes recovered and nonzero process exit preserved.',
  },
];

/** Generated command-parser cases, not claims about end-to-end coding task quality. */
export function noisyFixtures(variants = 1): SupportFixture[] {
  const diagnostics = [
    'file.ts(3,4): error TS2345: expected string, received number\n',
    'not ok 1 - preserves Unicode café 🔬\n',
    'FAILED tests/test_math.py::test_sum - AssertionError: 2 != 3\n',
    '--- FAIL: TestSum (0.01s)\n',
    'error[E0308]: mismatched types\n --> src/main.rs:8:3\n',
    'main.cpp:4:8: error: missing declaration\n',
  ];
  return Array.from({ length: variants }, (_, variant) => diagnostics.map((diagnostic, index) => {
    const text = 'build progress without diagnostic\n'.repeat(600 + variant * 10) + diagnostic;
    return { id: `noisy-${index}-${variant}`, kind: 'command' as const,
      task: 'Surface a tail diagnostic without replaying progress; preserve exact output for expansion.',
      expectedStdout: '', expectedStderr: text, expectedExit: 1, diagnosticTruth: 'error' as const,
      approvedArgv: [process.execPath, '-e', `process.stderr.write(${JSON.stringify(text)}); process.exitCode = 1`],
      qualityRubric: 'Exact stdout/stderr recovery, actual nonzero exit and visible diagnostic; generated parser corpus.' };
  })).flat();
}
