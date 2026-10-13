import { internalAccessFailure } from '../../../../lib/internal-auth.js';
import { dossierRequest, readDossierPage, DossierInputError, DossierReadError } from '../../../../lib/bullhorn-dossiers.js';

export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request) {
  const failure=internalAccessFailure(request);
  if(failure) return failure;
  try {
    const options=dossierRequest(new URL(request.url).searchParams);
    return Response.json(await readDossierPage(options),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    const input=error instanceof DossierInputError;
    return Response.json({ok:false,error:input?error.message:'Bullhorn dossier read failed.',...(error instanceof DossierReadError?{upstreamStatus:error.upstreamStatus}:{}),...(error.name==='TimeoutError'?{stage:'upstream_timeout'}:{})},{status:input?400:502,headers:{'Cache-Control':'no-store'}});
  }
}
