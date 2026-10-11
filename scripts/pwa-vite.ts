import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaConfig, publicAssets, workerFilename } from '../src/integrations/pwa-offline/config';
import { validBase, validPublicPath } from '../src/integrations/pwa-offline/policy';

// Start shares plugin instances across separately resolved client/SSR configs.
// Native PWA keeps its last resolved config and skips generation if that is SSR.
// Preserve the client config; applyToEnvironment alone does not filter configResolved.
function clientOnly(plugin: Plugin): Plugin {
 const hook=plugin.configResolved;
 return {...plugin,applyToEnvironment:environment=>environment.name==='client',
  configResolved:hook?{...(typeof hook==='object'?hook:{}),handler(config){
   if(config.build.ssr)return;
   return (typeof hook==='function'?hook:hook.handler).call(this,config);
  }}:undefined};
}

// Fixed, reviewed files only. No glob and no auto-inclusion of public uploads or app chunks.
export function pwaOffline(): PluginOption[] {
 if (!validBase(pwaConfig.base) || !pwaConfig.publicOfflinePaths.every(validPublicPath)) throw new Error('Invalid PWA base/public paths');
 const entries = publicAssets.map(url => {
  const bytes = readFileSync(resolve('public', url));
  const hash = createHash('sha256').update(bytes);
  if(url.endsWith('.png')&&!url.includes(createHash('sha256').update(bytes).digest('hex').slice(0,16)))throw new Error('Public icon fingerprint mismatch');
  return {url, size:bytes.length, revision: createHash('sha256').update(bytes).digest('hex'), integrity: `sha256-${hash.digest('base64')}`};
 });
 const version = createHash('sha256').update(JSON.stringify(entries)).update(JSON.stringify(pwaConfig)).update(readFileSync('src/integrations/pwa-offline/pwa-offline-sw.ts')).update(readFileSync('src/integrations/pwa-offline/policy.ts')).update(readFileSync('scripts/pwa-vite.ts')).update('vite-plugin-pwa@1.3.0/workbox-build@7.4.1').digest('hex');
 return [
  {name:'pwa-offline-contract', config: () => ({define:{__PWA_OFFLINE_VERSION__: JSON.stringify(version)}}), configResolved(config) {
   if(config.base !== pwaConfig.base) throw new Error('PWA base must equal Vite base');
  }},
  ...((VitePWA({strategies:'injectManifest', srcDir:'src/integrations/pwa-offline', filename:workerFilename.replace('.js','.ts'),
   injectRegister:false, registerType:'prompt', base:pwaConfig.base, scope:pwaConfig.base,
   includeAssets:[], includeManifestIcons:false, devOptions:{enabled:false},
   integration:{configureOptions(vite,options){options.outDir=vite.environments.client.build.outDir;},beforeBuildServiceWorker(options){options.injectManifest.additionalManifestEntries=[];}},
   manifest:pwaConfig.retired ? false : {id:pwaConfig.base, name:process.env.VITE_APP_NAME || 'LedgerCatch',short_name:process.env.VITE_APP_NAME || 'LedgerCatch',description:'Purchase ledger. Account content requires a connection.', start_url:`${pwaConfig.base}app`, scope:pwaConfig.base,display:'standalone',theme_color:'#0b0f17',background_color:'#0b0f17',
    shortcuts:[{name:'Capture receipt',short_name:'Capture',url:`${pwaConfig.base}app/capture`}],
    share_target:{action:`${pwaConfig.base}app/capture`,method:'POST',enctype:'multipart/form-data',params:{title:'title',text:'text',url:'url',files:[{name:'file',accept:['image/*','application/pdf','.pdf']}]}},
    icons:publicAssets.slice(1).map((url,i)=>({src:`${pwaConfig.base}${url}`,sizes:i===0?'192x192':'512x512',type:'image/png',purpose:'any'}))},
   injectManifest:{globPatterns:[],rollupFormat:'iife',
    manifestTransforms:[async manifest=>{
     if(manifest.length!==0) throw new Error('Unexpected PWA precache entries');
     return {manifest:entries.map(entry=>({...entry})),warnings:[]};
    }]},
  }) as unknown as Plugin[]).map(clientOnly)),
 ];
}
