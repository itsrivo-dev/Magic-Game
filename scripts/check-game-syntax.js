'use strict';

const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').resolve(__dirname,'../index.html'),'utf8');
const inline=[...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)];
if(inline.length!==1)throw new Error(`Expected one inline game script; found ${inline.length}.`);
new vm.Script(inline[0][1],{filename:'index.html:inline-game'});
process.stdout.write('Inline Mag IA game script syntax is valid.\n');
