async page => {
 const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=()=>page.waitForFunction(()=>!document.querySelector('#i-content')?.classList.contains('loading')&&document.querySelector('#i-content')?.textContent.length>30&&![...document.querySelectorAll('#i-content button')].some(b=>b.disabled));
 const tab=async name=>{await page.locator(`[data-i-tab="${name}"]`).click();await ready();};
 const noOverflow=async label=>{if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Page overflow: '+label);checks.push(label+' layout');};
 try {
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:47832/#insights');await page.reload();await page.locator('[data-i-tab="replay"]').waitFor();await tab('replay');await page.locator('[data-i-replay]').first().waitFor();
 await page.locator('[data-i-replay]').first().click();await page.locator('#i-replay-result .i-window-caption').waitFor();checks.push('peak replay');
 await page.locator('#i-replay-result [data-i-route]').first().click();await page.locator('#i-dialog[open] .i-route-graph').waitFor();await page.locator('[data-i-close]').click();checks.push('route evidence dialog');
 await page.locator('#i-compare-form button').click();await page.locator('#i-compare-result table').waitFor();checks.push('period comparison');
 await page.screenshot({path:'qa-output/v11-workbench.png'});await noOverflow('desktop');
 await tab('routes');await page.locator('#i-route-search').fill('codex.exe');await page.locator('#i-route-form button').click();await ready();if(!(await page.locator('#i-content').innerText()).includes('codex.exe'))throw new Error('Route search failed');checks.push('route search');
 await tab('projects');await page.locator('#i-project-name').fill('验收项目（仅副本）');await page.locator('#i-project-form button').click();await page.locator('.i-project').filter({hasText:'验收项目（仅副本）'}).waitFor();
 await page.locator('#i-binding-kind').selectOption('domain');await page.locator('#i-binding-domain').fill('chatgpt.com');await page.locator('#i-binding-form button').click();await ready();
 const project=page.locator('.i-project').filter({hasText:'验收项目（仅副本）'});await project.locator('[data-i-delete-binding]').waitFor();
 if(!(await project.innerText()).includes('codex.exe'))await project.locator('summary').click();checks.push('project create and bind');
 await project.locator('[data-i-delete-binding]').click();await ready();await project.locator('[data-i-delete-project]').click();await ready();checks.push('project rule and project removal');
 await tab('rules');await page.locator('#i-rule-name').fill('验收预算（仅副本）');await page.locator('#i-rule-direction').selectOption('upload');await page.locator('#i-rule-period').selectOption('day');await page.locator('#i-rule-limit').fill('0.01');await page.locator('#i-rule-form button').click();await page.locator('.i-budget').filter({hasText:'验收预算（仅副本）'}).waitFor();
 const budget=page.locator('.i-budget').filter({hasText:'验收预算（仅副本）'});await budget.locator('[data-i-toggle-rule]').click();await ready();if(!(await budget.innerText()).includes('已关闭'))throw new Error('Rule toggle failed');await budget.locator('[data-i-delete-rule]').click();await ready();checks.push('budget create, disable and delete');
 await page.locator('#i-rule-kind').selectOption('new-destination');if(await page.locator('#i-limit-field').isVisible())throw new Error('Discovery rule fields');await page.locator('#i-rule-kind').selectOption('spike');if(!await page.locator('#i-factor-field').isVisible())throw new Error('Spike fields');checks.push('discovery and spike rule forms');
 await tab('ai');
 await page.locator('#i-ai-file').setInputFiles('qa-output/v11-preview-metrics.json');await page.locator('#i-content td').filter({hasText:'SDK 验收样本（仅副本）'}).first().waitFor();if(await page.locator('.i-section').filter({hasText:'重复附件线索'}).locator('tbody tr').count()<1)throw new Error('Repeat-image evidence missing');checks.push('AI metadata file import and repeated-image evidence');
 await page.locator('[data-i-ai-scan]').click();await ready();await page.waitForFunction(()=>document.querySelector('#i-feedback')?.textContent.includes('导入'));checks.push('read-only Codex metadata scan');
 await tab('network');await page.locator('#i-probe-host').fill('127.0.0.1');await page.locator('#i-probe-port').fill('47832');await page.locator('#i-probe-count').selectOption('1');await page.locator('#i-probe-tls').uncheck();await page.locator('#i-probe-form button').click();await page.waitForFunction(()=>document.querySelector('#i-feedback')?.textContent.includes('诊断完成'));if(!(await page.locator('#i-probe-result').innerText()).includes('1 / 1'))throw new Error('Local TCP probe failed');checks.push('on-demand local connection probe');
 const downloadPromise=page.waitForEvent('download');await page.locator('[data-i-export]').click();const download=await downloadPromise;await download.saveAs('qa-output/v11-ui-diagnostic.json');checks.push('redacted download');
 await tab('trust');await page.locator('.i-health').waitFor();checks.push('confidence, gaps and retention');
 await page.setViewportSize({width:520,height:850});for(const name of ['replay','routes','projects','rules','ai','network','trust']){await tab(name);await noOverflow('520px '+name);}
 await page.setViewportSize({width:390,height:844});await tab('replay');await noOverflow('390px');await page.screenshot({path:'qa-output/v11-workbench-narrow.png'});
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:47832/#overview');await page.locator('#rankings .rank-row').first().waitFor();await page.locator('#traffic-chart').click({position:{x:120,y:90}});await page.locator('#i-replay-result .i-window-caption').waitFor();checks.push('overview chart opens replay');
 if(errors.length)throw new Error(JSON.stringify(errors));return {checks,pageErrors:errors,previewOnlyMutations:true};
 }catch(e){return {checks,error:e.message,pageErrors:errors,visibleTab:await page.locator('.i-tabs .active').innerText()};}
}
