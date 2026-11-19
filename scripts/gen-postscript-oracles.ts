import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { generateOracles } from './postscript-oracle-runner.js';
import { oracleCases } from '../test/helpers/postscript-oracle-cases.js';

export async function main(args=process.argv.slice(2)):Promise<void> {
  const opts=new Map<string,string>();
  for(let i=0;i<args.length;i+=2) {
    if(!['--gs','--out'].includes(args[i]!)||!args[i+1]||opts.has(args[i]!)) throw new Error('Usage: --gs <10.07.1 executable> [--out <references directory>]');
    opts.set(args[i]!,args[i+1]!);
  }
  if(!opts.has('--gs')) throw new Error('--gs is required');
  const root=fileURLToPath(new URL('../',import.meta.url));
  await generateOracles({root,command:{executable:resolve(opts.get('--gs')!),prefixArgs:[]},
    outDir:resolve(opts.get('--out')??'test/fixtures/postscript-oracle/references'),cases:oracleCases(root)});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error(e);process.exitCode=1;});
}
