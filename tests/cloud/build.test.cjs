'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
test('Vercel build switches API while preserving MAMP source and excludes server/private files',()=>{
 const secret='postgresql://test_build_only:never_publish@example.invalid/troika';
 const before=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const result=spawnSync(process.execPath,['scripts/build.cjs'],{cwd:root,env:{...process.env,DATABASE_URL:secret},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const files=fs.readdirSync(path.join(root,'public'),{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>path.relative(path.join(root,'public'),path.join(x.parentPath||x.path,x.name)).replaceAll('\\','/'));
 assert.ok(files.includes('index.html'));assert.ok(files.includes('assets/app.js'));
 for(const file of files){assert.ok(file==='index.html'||file.startsWith('assets/')||file==='docs/jump-in-guide.html',file);assert.ok(!file.endsWith('.php'));assert.ok(!fs.readFileSync(path.join(root,'public',file),'utf8').includes(secret));}
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');assert.ok(html.includes('<meta name="troika-api" content="/api/game">'));assert.ok(html.includes('ONLINE PLAY'));assert.ok(!html.includes('Local network · No accounts'));assert.equal(fs.readFileSync(path.join(root,'index.html'),'utf8'),before);
 const config=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));assert.equal(config.outputDirectory,'public');assert.equal(config.framework,null);assert.ok(config.rewrites.some(x=>x.source==='/api.php'&&x.destination==='/api/game'));assert.ok(config.functions['api/*.js']);assert.equal(config.functions['api/*.js'].includeFiles,'cloud/**');assert.ok(!files.some(p=>p.includes('owner-bootstrap')));
});
