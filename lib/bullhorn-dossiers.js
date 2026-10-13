import { getBullhornRestSession } from './bullhorn-session.js';

const SCALAR_FIELDS = ['id','name','firstName','lastName','status','occupation','companyName','description','comments','skillSet','certifications','educationDegree','employmentPreference','experience','salary','salaryLow','travelLimit','travelMethod','willRelocate','dateAvailable','dateLastComment','dateAdded','dateLastModified','isDeleted', ...Array.from({length:20},(_,i)=>`customText${i+1}`), ...Array.from({length:5},(_,i)=>`customTextBlock${i+1}`)];
const NOTE_FIELDS = 'id,action,comments,dateAdded,dateLastModified,isDeleted,personReference(id,name),candidates[10](id),jobOrder(id,title),commentingPerson(id,name)';

export class DossierInputError extends Error {}

function integer(value, name, fallback, maximum) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new DossierInputError(`Invalid ${name}.`);
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n>maximum || n<(name==='start'?0:1)) throw new DossierInputError(`Invalid ${name}.`);
  return n;
}

export function dossierRequest(params) {
  const mode=params.get('mode') || 'candidates';
  if (!['candidates','notes','schema','noteIndex','files','file'].includes(mode)) throw new DossierInputError('Unsupported mode.');
  const start=integer(params.get('start'),'start',0,1000000);
  const count=integer(params.get('count'),'count',100,100);
  const candidateId=integer(params.get('candidateId'),'candidateId',null,Number.MAX_SAFE_INTEGER);
  const fileId=integer(params.get('fileId'),'fileId',null,Number.MAX_SAFE_INTEGER);
  if (['files','file'].includes(mode) && !candidateId) throw new DossierInputError('candidateId is required.');
  if (mode==='file' && !fileId) throw new DossierInputError('fileId is required.');
  return {mode,start,count,candidateId,fileId};
}

async function requestJson(session,path,params={}) {
  const url=new URL(path,session.restUrl.endsWith('/')?session.restUrl:session.restUrl+'/');
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
  const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json',BhRestToken:session.BhRestToken},signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Bullhorn dossier read returned HTTP ${response.status}.`);
  return response.json();
}

export async function readDossierPage(options,providedSession) {
  const session=providedSession || await getBullhornRestSession();
  const {mode,start,count,candidateId,fileId}=options;
  if(mode==='schema') {
    // Wildcard here describes field metadata only, never candidate data.
    const schema=await requestJson(session,'meta/Candidate',{fields:'*',meta:'full'});
    return {ok:true,mode,fields:schema.fields.map(f=>({name:f.name,label:f.label,type:f.type,dataType:f.dataType})),retrievedAt:new Date().toISOString()};
  }
  if(mode==='noteIndex') return {ok:true,mode,index:await requestJson(session,'search/Note')};
  if(mode==='files') return {ok:true,mode,candidateId,attachments:await requestJson(session,`entityFiles/Candidate/${candidateId}`)};
  if(mode==='file') {
    // File must be attached to this exact candidate; Bullhorn enforces file entitlements.
    return {ok:true,mode,candidateId,fileId,file:await requestJson(session,`file/Candidate/${candidateId}/${fileId}`)};
  }
  let page, fields;
  if(mode==='candidates') {
    const schema=await requestJson(session,'meta/Candidate',{fields:'*',meta:'full'});
    const names=new Set(schema.fields.map(f=>f.name));
    fields=SCALAR_FIELDS.filter(f=>names.has(f));
    if(names.has('address')) fields.push('address(city,state,zip,countryID)');
    if(names.has('primarySkills')) fields.push('primarySkills[10](id,name)');
    if(names.has('categories')) fields.push('categories[10](id,name)');
    if(names.has('parsedResumeFile')) fields.push('parsedResumeFile(id,name)');
    page=await requestJson(session,'search/Candidate',{query:'isDeleted:0',sort:'id',fields:fields.join(','),start,count});
  } else {
    // Note's isDeleted search-index filter returned zero in the live tenant.
    // Read explicit fields, then expose deletion flags for local suppression.
    page=await requestJson(session,'search/Note',{query:'id:[1 TO *]',fields:NOTE_FIELDS,start,count});
  }
  const data=Array.isArray(page.data)?page.data:[];
  return {ok:true,mode,start,count:data.length,total:page.total??null,nextStart:data.length===count?start+data.length:null,fields, data,retrievedAt:new Date().toISOString()};
}
