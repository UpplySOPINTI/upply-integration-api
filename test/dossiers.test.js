import assert from 'node:assert/strict';
import test from 'node:test';
import { dossierRequest, readDossierPage } from '../lib/bullhorn-dossiers.js';
import { GET } from '../app/api/bullhorn/dossiers/route.js';
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch;delete process.env.INTEGRATION_ADMIN_KEY;});
test('refuses access before contacting Bullhorn',async()=>{
  process.env.INTEGRATION_ADMIN_KEY='secret';
  globalThis.fetch=()=>{throw Error('must not fetch');};
  assert.equal((await GET(new Request('https://test/dossiers'))).status,401);
});
test('validates modes, pagination and candidate/file identifiers',()=>{
  for(const q of ['mode=arbitrary','count=101','start=-1','candidateId=1/../../','mode=file&candidateId=1','mode=files']) assert.throws(()=>dossierRequest(new URLSearchParams(q)));
  assert.equal(dossierRequest(new URLSearchParams('start=100&count=100')).start,100);
});
test('uses explicit supported candidate fields and passes pagination without credentials in URL',async()=>{
  let call;
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('/meta/')) return Response.json({fields:['id','name','description','address','ssn','password'].map(name=>({name}))});
    call={url:new URL(url),init};return Response.json({total:2,data:[{id:1,name:'Test',description:'Azure engineer'}]});
  };
  const result=await readDossierPage(dossierRequest(new URLSearchParams('start=1&count=1')),{restUrl:'https://rest72.test/rest-services/corp/',BhRestToken:'token'});
  assert.equal(call.url.searchParams.get('start'),'1');assert.equal(call.url.searchParams.get('count'),'1');
  assert.equal(call.url.searchParams.has('BhRestToken'),false);assert.equal(call.init.headers.BhRestToken,'token');
  assert.equal(call.url.searchParams.get('fields').includes('ssn'),false);assert.equal(call.url.searchParams.get('fields').includes('password'),false);
  assert.equal(result.nextStart,2);assert.equal(result.total,2);
});
test('keeps actual note deletion flags and never silently converts upstream failure to empty data',async()=>{
  globalThis.fetch=async()=>Response.json({data:[{id:4,isDeleted:true}]});
  const opts=dossierRequest(new URLSearchParams('mode=notes'));
  const session={restUrl:'https://rest72.test/corp/',BhRestToken:'token'};
  assert.equal((await readDossierPage(opts,session)).data[0].isDeleted,true);
  globalThis.fetch=async()=>new Response('private error details',{status:403});
  await assert.rejects(()=>readDossierPage(opts,session),/HTTP 403/);
});
