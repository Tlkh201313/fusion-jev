import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { JevProvider } from '../src/providers/jev.js';
import { ESCALATE, type PreparedRequest } from '../src/types.js';

test('official TypeSafe key configures direct Jev and blocks credential redirects', async () => {
  const config = loadConfig({ TYPESAFE_API_KEY: 'fake-typesafe-key' });
  assert.equal(config.jev.apiKey, 'fake-typesafe-key');
  assert.equal(config.jev.baseUrl, 'https://api.typesafe.ai');
  assert.equal(config.jev.model, 'jev-latest');
  assert.equal(config.gpt.apiKey, undefined);
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer fake-typesafe-key');
    assert.equal(JSON.parse(String(init?.body)).model, 'jev-latest');
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { q0: { type:'choice', choice:'a', confidence:0.9,
      probabilities:{a:0.9,[ESCALATE]:0.1} } }, usage:{input_tokens:5,output_tokens:2} }));
  };
  const request: PreparedRequest = {task:'Pick a',tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
    candidates:[{id:'a',tool:'lookup',arguments:{}}],strategy:'fusion'};
  assert.equal((await new JevProvider(config.jev,fetcher).choose([request],new AbortController().signal)).answers[0]?.choice,'a');
});

test('direct compatibility alias never accepts TeamoRouter credentials', () => {
  assert.equal(loadConfig({JEV_API_KEY:'alias-key'}).jev.apiKey,'alias-key');
  assert.equal(loadConfig({TYPESAFE_API_KEY:'same',JEV_API_KEY:'same'}).jev.apiKey,'same');
  assert.throws(()=>loadConfig({TYPESAFE_API_KEY:'first-secret',JEV_API_KEY:'second-secret'}),error=>
    error instanceof Error && /Conflicting/.test(error.message) && !/first-secret|second-secret/.test(error.message));
  assert.equal(loadConfig({TEAMOROUTER_API_KEY:'old-provider-key'}).jev.apiKey,undefined);
});

test('official origin and models are validated before receiving a key', () => {
  for (const baseUrl of ['https://api.teamorouter.com','https://attacker.example','http://api.typesafe.ai','https://api.typesafe.ai/path'])
    assert.throws(()=>loadConfig({JEV_BASE_URL:baseUrl,TYPESAFE_API_KEY:'fake'}),/JEV_BASE_URL/);
  assert.equal(loadConfig({JEV_BASE_URL:'https://api.typesafe.ai',JEV_MODEL:'jev-1.13.0'}).jev.model,'jev-1.13.0');
  assert.equal(loadConfig({JEV_MODEL:'jev-preview'}).jev.model,'jev-preview');
  assert.throws(()=>loadConfig({JEV_MODEL:'jev'}),/JEV_MODEL/);
});

test('workspace opt-in and MCP profile retain strict configuration',()=>{
  assert.equal(loadConfig({}).mcpProfile,'assist');
  assert.equal(loadConfig({FUSION_MCP_PROFILE:'full'}).mcpProfile,'full');
  assert.throws(()=>loadConfig({FUSION_MCP_PROFILE:'legacy'}),/FUSION_MCP_PROFILE/);
  assert.equal(loadConfig({FUSION_WORKSPACE_ROOT:'C:/private/repo'}).http.enableWorkspace,false);
  assert.equal(loadConfig({FUSION_HTTP_ENABLE_WORKSPACE:'true'}).http.enableWorkspace,true);
  assert.throws(()=>loadConfig({FUSION_HTTP_ENABLE_WORKSPACE:'yes'}),/FUSION_HTTP_ENABLE_WORKSPACE/);
});
