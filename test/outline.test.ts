import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, findSymbols, outlineLanguage, renderOutline, type OutlineLanguage } from '../src/outline.js';

const outline = (language: OutlineLanguage, source: string) => buildOutline(language, source.split('\n'));
const rows = (language: OutlineLanguage, source: string) =>
  outline(language, source).symbols.map(s => `${s.parent ? `${s.parent}.` : ''}${s.name}:${s.kind}:${s.startLine}-${s.endLine}${s.exported ? ':x' : ''}`);

test('language detection by extension', () => {
  assert.equal(outlineLanguage('a/b.tsx'), 'typescript');
  assert.equal(outlineLanguage('a.cjs'), 'javascript');
  assert.equal(outlineLanguage('x.py'), 'python');
  assert.equal(outlineLanguage('x.go'), 'go');
  assert.equal(outlineLanguage('x.rs'), 'rust');
  assert.equal(outlineLanguage('X.java'), 'java');
  assert.equal(outlineLanguage('X.cs'), 'csharp');
  assert.equal(outlineLanguage('x.bin'), undefined);
});

test('TypeScript: classes, members, arrows, braces inside strings, templates and regexes', () => {
  const source = [
    'import { a } from "./a.js";',
    '',
    'export interface Options { a: string }',
    'export type Id = string;',
    'const hidden = (x: number) => {',
    '  return `}${x}{`;',
    '};',
    'export class Router {',
    '  private cache = new Map();',
    '  constructor(readonly opts: Options) {}',
    '  async route(req: string): Promise<void> {',
    '    const re = /\\{+/;',
    '    if (req === "}") { return; }',
    '  }',
    '  private helper() {',
    '    return 1;',
    '  }',
    '}',
    'export async function main(',
    '  argv: string[],',
    '): Promise<number> {',
    '  return 0;',
    '}',
    'export const VERSION = "1";',
    'export const run = async () => 1;',
  ].join('\n');
  assert.deepEqual(rows('typescript', source), [
    'Options:interface:3-3:x', 'Id:type:4-4:x', 'hidden:function:5-7',
    'Router:class:8-18:x', 'Router.constructor:method:10-10:x', 'Router.route:method:11-14:x', 'Router.helper:method:15-17',
    'main:function:19-23:x', 'VERSION:const:24-24:x', 'run:function:25-25:x',
  ]);
});

test('TypeScript without semicolons closes unbraced declarations before the next one and flags them approximate', () => {
  const result = outline('typescript', ['export const a = 1', 'export const b = 2', 'export function f() {', '}'].join('\n'));
  assert.deepEqual(result.symbols.map(s => [s.name, s.startLine, s.endLine]), [['a', 1, 1], ['b', 2, 2], ['f', 3, 4]]);
  assert.equal(result.symbols[0]!.approx, true);
  assert.equal(result.symbols[2]!.approx, undefined);
});

test('JavaScript: function declarations, default exports and classes', () => {
  const source = ['function a() {', '  return {', '    x: 1,', '  };', '}', 'export default function () {', '}', 'class B extends A {', '  static make() { return new B(); }', '}'].join('\n');
  assert.deepEqual(rows('javascript', source), ['a:function:1-5', 'default:function:6-7:x', 'B:class:8-10', 'B.make:method:9-9:x']);
});

test('Python: indentation ends, methods, decorators, docstrings, multi-line signatures', () => {
  const source = [
    'import os',
    '',
    'class Service(Base):',
    '    """Doc',
    '    def not_a_method(self): pass',
    '    """',
    '    @property',
    '    def name(self):',
    '        return 1',
    '',
    '    def _private(self,',
    '                 x):',
    '        def inner():',
    '            pass',
    '        return x',
    '',
    'async def run(a,',
    '    b,',
    '):',
    '    return a',
    '',
    'def _hidden():',
    '    pass',
  ].join('\n');
  assert.deepEqual(rows('python', source), [
    'Service:class:3-15:x', 'Service.name:method:8-9:x', 'Service._private:method:11-15',
    'run:function:17-20:x', '_hidden:function:22-23',
  ]);
});

test('Go: functions, methods with receivers, structs, interfaces, types and consts; exported by capitalisation', () => {
  const source = [
    'package main',
    'type Server struct {',
    '\tName string',
    '}',
    'type Handler interface {',
    '\tServe() error',
    '}',
    'type ID int',
    'const Max = 5',
    'func (s *Server) Start(addr string) error {',
    '\tmsg := "}"',
    '\treturn nil',
    '}',
    'func helper() {}',
    'var raw = `',
    '}`',
    'func Last() {',
    '}',
  ].join('\n');
  assert.deepEqual(rows('go', source), [
    'Server:struct:2-4:x', 'Handler:interface:5-7:x', 'ID:type:8-8:x', 'Max:const:9-9:x', 'Server.Start:method:10-13:x',
    'helper:function:14-14', 'raw:var:15-16', 'Last:function:17-18:x',
  ]);
});

test('Rust: pub items, impl blocks with methods, traits, lifetimes and char literals', () => {
  const source = [
    'use std::fmt;',
    'pub struct Point<T> {',
    '    x: T,',
    '}',
    'impl<T: Copy> Point<T> {',
    '    pub fn new(x: T) -> Self { Point { x } }',
    "    fn peek<'a>(&'a self) -> char {",
    "        '}'",
    '    }',
    '}',
    'pub trait Shape {',
    '    fn area(&self) -> f64;',
    '}',
    'impl Shape for Point<f64> {',
    '    fn area(&self) -> f64 { 0.0 }',
    '}',
    'pub(crate) async fn run() {',
    '}',
    'const LIMIT: usize = 4;',
  ].join('\n');
  assert.deepEqual(rows('rust', source), [
    'Point:struct:2-4:x', 'Point<T>:impl:5-10', 'Point<T>.new:method:6-6:x', 'Point<T>.peek:method:7-9',
    'Shape:trait:11-13:x', 'Shape.area:method:12-12:x', 'Shape for Point<f64>:impl:14-16', 'Shape for Point<f64>.area:method:15-15:x',
    'run:function:17-18:x', 'LIMIT:const:19-19',
  ]);
});

test('Java: public types, annotations, generics, interfaces; enum constants are not methods', () => {
  const source = [
    'package a;',
    'public class Repo<T> extends Base {',
    '    private final Map<String, T> items = new HashMap<>();',
    '    @Override',
    '    public T find(String id) {',
    '        return items.get(id);',
    '    }',
    '    private static <R> List<R> all(int n)',
    '        throws Exception',
    '    {',
    '        return null;',
    '    }',
    '    public enum Mode { A, B }',
    '}',
    'interface Store {',
    '    void save(String s);',
    '}',
    'enum Color {',
    '    RED(1),',
    '    GREEN(2);',
    '    int code() { return 1; }',
    '}',
  ].join('\n');
  assert.deepEqual(rows('java', source), [
    'Repo:class:2-14:x', 'Repo.find:method:5-7:x', 'Repo.all:method:8-12', 'Repo.Mode:enum:13-13:x',
    'Store:interface:15-17', 'Store.save:method:16-16', 'Color:enum:18-22', 'Color.code:method:21-21',
  ]);
});

test('C#: namespaces, Allman braces, properties, expression members', () => {
  const source = [
    'namespace App.Core',
    '{',
    '    public sealed class Engine : IDisposable',
    '    {',
    '        public int Count { get; set; }',
    '        public Engine(int n) { Count = n; }',
    '        public async Task<int> RunAsync(string s)',
    '        {',
    '            return await Task.FromResult(1);',
    '        }',
    '        private void Step() { }',
    '    }',
    '    internal interface IThing { void Do(); }',
    '}',
  ].join('\n');
  assert.deepEqual(rows('csharp', source), [
    'App.Core:namespace:1-14:x', 'App.Core.Engine:class:3-12:x', 'Engine.Count:property:5-5:x', 'Engine.Engine:method:6-6:x',
    'Engine.RunAsync:method:7-10:x', 'Engine.Step:method:11-11', 'App.Core.IThing:interface:13-13',
  ]);
});

test('Markdown headings and rendering: exported first, findSymbols resolves Parent.member', () => {
  const md = outline('markdown', ['# Title', 'text', '## Part', '```', '# not a heading', '```', '## Next', 'x'].join('\n'));
  assert.deepEqual(md.symbols.map(s => [s.name, s.startLine, s.endLine]), [['Title', 1, 8], ['Part', 3, 6], ['Next', 7, 8]]);
  const ts = outline('typescript', ['class A {', '  go() {}', '}', 'export function go() {}'].join('\n'));
  const rendered = renderOutline('src/a.ts', ts);
  assert.match(rendered, /exported:\n {2}4-4 function go\n.*internal:\n {2}1-3 class A\n {4}2-2 method go/s);
  assert.deepEqual(findSymbols(ts.symbols, 'go').map(s => s.startLine), [4, 2], 'exported top-level first, then the member');
  assert.deepEqual(findSymbols(ts.symbols, 'A.go').map(s => s.startLine), [2]);
  assert.deepEqual(findSymbols(ts.symbols, 'missing'), []);
});

test('very long lines and unbalanced input do not throw and close open symbols at end of file', () => {
  const result = outline('typescript', 'export function broken() {\n' + 'x'.repeat(5000) + '\n  if (a) {\n');
  assert.equal(result.symbols[0]!.endLine, 4);
  assert.equal(result.symbols[0]!.approx, true);
});
