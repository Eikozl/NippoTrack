import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './helpers/browser.mjs';

test('Phase 12 real DOM stabilization', { skip: !process.env.JLT_BROWSER, timeout: 120000 }, async t => {
  const browser = await browserFixture();
  t.after(() => browser.close());
  const run = browser.evaluate;
  await run(`
    window.requests = []; window.saved = [];
    window.candidate = {key:'go',canonical:'行く',lemma:'行く',lemmaReading:null,pos:'verb',occurrences:1,observed:[{surface:'行った',surfaceReading:'いった'}],match:{state:'new'}};
    window.analysis = {kanji:[],lexical:{status:'ok',candidates:[candidate],unverified:[],summary:{candidates:1,existing:0,new:1},matching:{available:true}}};
    window.fetch = async (path, options = {}) => {
      requests.push(String(path));
      let data;
      if (String(path).startsWith('/api/kanji/reference?')) {
        if (window.failConversion) throw Error('offline');
        if (window.holdConversion) await new Promise(resolve => window.releaseConversion = resolve);
        const word = new URL(path, location.href).searchParams.get('search');
        data = {transliteration: {hiragana: ({iku:'いく',gakkou:'がっこう',taberu:'たべる'})[word]}};
      } else if (path === '/api/analyze/text') data = analysis;
      else if (options.method === 'POST' || options.method === 'PUT') {data = {id_vocabulary:1,...JSON.parse(options.body)}; saved.push(data);}
      else if (path === '/api/vocabulary/1') data = {id_vocabulary:1,word:'行く',reading:'',meaning:'to go',status:'New'};
      else data = {items:[{id_vocabulary:1,word:'行く',reading:'',meaning:'to go',status:'New'}],pagination:{page:1,totalPages:1,total:1,limit:30}};
      return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
    };
    window.tick = () => new Promise(resolve => setTimeout(resolve,100));
    window.clickText = text => { const node = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === text); if (!node) throw Error('Button missing: '+text); node.click(); };
    window.openAnalyzer = async () => {
      document.getElementById('modal-root').replaceChildren();
      const {renderAnalyzer} = await import('/src/pages/analyzer.js');
      await renderAnalyzer(document.getElementById('app'));
      document.querySelector('textarea').value = '学校に行った。'; clickText('Analyze text'); await tick(); clickText('Add 行く');
    };
    window.convert = async value => {const input = document.querySelector('[name="reading"]'); input.focus(); if(document.activeElement!==input) throw Error('Reading did not receive focus'); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); input.blur(); await tick(); return input.value;};
    window.openNormal = async edit => {
      document.getElementById('modal-root').replaceChildren();
      const {renderEntityPage,ENTITY_CONFIGS} = await import('/src/pages/entityPage.js');
      renderEntityPage(document.getElementById('app'),ENTITY_CONFIGS.vocabulary); await tick();
      if (edit) { const button = [...document.querySelectorAll('button')].find(n => n.getAttribute('aria-label')?.startsWith('Edit') || n.textContent.trim()==='Edit'); if (!button) throw Error('Edit missing'); button.click(); await tick(); }
      else clickText('Add vocabulary entry');
    };
  `);
  for (const mode of ['Analyzer', 'Vocabulary create', 'Vocabulary edit']) {
    await t.test(`${mode}: blur converts romaji and preserves kana, failure, and newer input`, { timeout: 15000 }, async () => {
      await run(mode === 'Analyzer' ? 'openAnalyzer()' : `openNormal(${mode.endsWith('edit')})`);
      assert.equal(await run(`document.querySelector('[name="reading"]').value`), '');
      for (const [input, expected] of [['iku','いく'],['gakkou','がっこう'],['taberu','たべる'],['たべる','たべる'],['タベル','タベル']]) {
        const actual = await run(`convert(${JSON.stringify(input)})`);
        assert.equal(actual, expected, `${mode}: ${input}`);
      }
      assert.equal(await run(`(async()=>{window.failConversion=true;const value=await convert('iku');window.failConversion=false;return value})()`), 'iku');
      assert.equal(await run(`(async()=>{window.holdConversion=true;const input=document.querySelector('[name="reading"]');input.value='iku';input.dispatchEvent(new Event('blur'));for(let i=0;i<20&&!window.releaseConversion;i++)await new Promise(r=>setTimeout(r,10));if(!window.releaseConversion) throw Error('No request reached API');input.value='newer';window.releaseConversion();window.holdConversion=false;await tick();return input.value})()`), 'newer');
    });
  }
  await t.test('Analyzer saves visible kana, moves card, and updates summary without reanalysis', async () => {
    const result = await run(`(async()=>{await openAnalyzer();await convert('iku');document.querySelector('[name="meaning"]').value='to go';clickText('Add to Vocabulary');await tick();const section=document.querySelector('[aria-label="Vocabulary analysis"]');return {saved:saved.at(-1),text:section.textContent,tiles:[...section.querySelectorAll('.text-xl')].map(n=>n.textContent),server:analysis.lexical.summary};})()`);
    assert.equal(result.saved.reading, 'いく');
    assert.match(result.text, /Already in Vocabulary \(1\)/);
    assert.deepEqual(result.tiles, ['1','1','0']);
    assert.deepEqual(result.server, {candidates:1,existing:0,new:1});
  });
  await t.test('Editing the saved word does not mark the original candidate owned', async () => {
    const result = await run(`(async()=>{await openAnalyzer();document.querySelector('[name="word"]').value='帰る';document.querySelector('[name="meaning"]').value='return';clickText('Add to Vocabulary');await tick();return document.querySelector('[aria-label="Vocabulary analysis"]').textContent;})()`);
    assert.match(result, /New Vocabulary \(1\)/);
    assert.doesNotMatch(result, /Already in Vocabulary \(1\)/);
  });
  for (const width of [320,360,375,390,430,768,1280]) {
    await t.test(`Estimate ${width}px: first and subsequent open fit the real header geometry`, async () => {
      const viewportHeight = width <= 430 ? 568 : 800;
      await browser.send('Emulation.setDeviceMetricsOverride', {width,height:viewportHeight,deviceScaleFactor:1,mobile:false});
        const result = await run(`(async()=>{
        document.getElementById('modal-root').replaceChildren();
        document.getElementById('app').innerHTML='<header style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px"><button style="width:40px;height:40px"></button><div id="estimate-controls" style="display:flex;gap:8px"><button style="width:40px;height:40px"></button><button style="width:40px;height:40px"></button><button style="width:40px;height:40px"></button></div></header>';
        const {element}=await import('/src/ui.js');
        const {createLevelEstimateControl}=await import('/src/levelEstimateControl.js');
        const control=createLevelEstimateControl({createElement:element,doc:document,win:window,fetchEstimate:async()=>({estimate:{level:'N5',status:'estimated',confidence:'moderate'}})});
        const host=control.mount(document.getElementById('estimate-controls'));await control.load();
        const wait=()=>new Promise(resolve=>setTimeout(resolve,450));await wait();
        const morph=host.querySelector('section');
        const measurements=[];
        for(let i=0;i<2;i++) {
          host.querySelector('button').click();await wait();
          const rect=morph.getBoundingClientRect(),style=getComputedStyle(morph);
          measurements.push({width:rect.width,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,height:rect.height,faceHeight:host.querySelector('button').getBoundingClientRect().height,contentOverflowX:morph.scrollWidth>morph.clientWidth,overflow:document.documentElement.scrollWidth>innerWidth,inlineHeight:morph.style.height,inlineMaxHeight:morph.style.maxHeight,position:style.position,maxHeight:style.maxHeight,overflowY:style.overflowY,flip:morph.classList.contains('is-flip')});
          control.close();await wait();
        }
        control.destroy();return measurements;
      })()`);
      for (const rect of result) {
        assert.ok(!rect.overflow, 'underlying page has no horizontal overflow');
        assert.ok(!rect.contentOverflowX, 'panel content has no horizontal clipping');
        assert.equal(rect.inlineHeight, '', 'no inline measured height');
        assert.equal(rect.inlineMaxHeight, '', 'no inline measured max-height');
        assert.equal(rect.flip, false, 'mobile and desktop use the shared connected surface');
        if (width <= 640) {
          assert.ok(rect.left >= 15, `left edge ${rect.left} keeps the mobile margin`);
          assert.ok(rect.right <= width - 15, `right edge ${rect.right} keeps the mobile margin`);
          assert.ok(Math.abs(rect.width - (width - 32)) < 2, `width ${rect.width} fills the available viewport`);
          assert.ok(rect.top >= 11 && rect.bottom <= viewportHeight - 11, 'panel remains vertically viewport-safe');
          assert.ok(rect.height > rect.faceHeight, 'panel expands downward beyond the collapsed face');
          assert.equal(rect.position, 'fixed', 'mobile geometry is viewport-based CSS');
          assert.notEqual(rect.maxHeight, 'none', 'mobile has a viewport-safe height cap');
          assert.equal(rect.overflowY, 'auto', 'mobile scrolls only when content exceeds the cap');
        } else {
          assert.ok(rect.left >= 0 && rect.right <= width + 1, 'desktop/tablet viewport fit');
        }
      }
      if (width <= 640) {
        for (const key of ['left','right','width','top','bottom','height']) {
          assert.ok(Math.abs(result[0][key]-result[1][key])<1, `${key} agrees on first and subsequent mobile open`);
        }
      } else {
        assert.ok(Math.abs(result[0].height-result[1].height)<3, 'desktop/tablet open height stays coherent');
      }
      t.diagnostic(`${width}px first ${JSON.stringify(result[0])}; second ${JSON.stringify(result[1])}`);
    });
  }
  await t.test('Estimate mobile long content stays viewport-safe and scrollable', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', {width:360,height:480,deviceScaleFactor:1,mobile:false});
    const result = await run(`(async()=>{
      document.getElementById('app').innerHTML='<header style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px"><button style="width:40px;height:40px"></button><div id="estimate-controls" style="display:flex;gap:8px"><button style="width:40px;height:40px"></button><button style="width:40px;height:40px"></button><button style="width:40px;height:40px"></button></div></header>';
      const {element}=await import('/src/ui.js');
      const {createLevelEstimateControl}=await import('/src/levelEstimateControl.js');
      const longLines=Array.from({length:16},(_,i)=>'Long responsive evidence line '+i+' remains readable inside the mobile panel.');
      const control=createLevelEstimateControl({createElement:element,doc:document,win:window,fetchEstimate:async()=>({estimate:{level:'N5',status:'estimated',confidence:'moderate'},reasoning:longLines,limitations:longLines})});
      const host=control.mount(document.getElementById('estimate-controls'));await control.load();
      host.querySelector('button').click();
      await new Promise(resolve=>setTimeout(resolve,200));
      const morph=host.querySelector('section'),details=morph.querySelector('details');
      details.open=true;
      await new Promise(resolve=>setTimeout(resolve,200));
      const rect=morph.getBoundingClientRect(),style=getComputedStyle(morph);
      const outcome={left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,clientHeight:morph.clientHeight,scrollHeight:morph.scrollHeight,contentOverflowX:morph.scrollWidth>morph.clientWidth,overflowY:style.overflowY,pageOverflow:document.documentElement.scrollWidth>innerWidth};
      control.destroy();return outcome;
    })()`);
    assert.ok(result.left >= 15 && result.right <= 345, 'long panel keeps both mobile margins');
    assert.ok(result.top >= 11 && result.bottom <= 469, 'long panel stays inside the mobile viewport');
    assert.ok(result.scrollHeight > result.clientHeight, 'long content exceeds the visible panel height');
    assert.equal(result.overflowY, 'auto', 'long content receives controlled vertical scrolling');
    assert.equal(result.contentOverflowX, false, 'long content remains horizontally readable');
    assert.equal(result.pageOverflow, false, 'long content does not create horizontal page scrolling');
    t.diagnostic(`360x480 long-content ${JSON.stringify(result)}`);
  });
});
