async page => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:47831/');
  await page.locator('#internal-accounting').waitFor({state:'visible'});
  const internalText=await page.locator('#internal-accounting').innerText();
  if(!internalText.includes('不加入四榜'))throw new Error('Missing accounting explanation');
  const rankingText=await page.locator('#rankings').innerText();
  if(rankingText.includes('代理核心内部连接')||rankingText.includes('未知程序'))throw new Error('Internal flow in application rankings');
  await page.screenshot({path:'qa-output/inner-accounting-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'查看内部连接 ↗',exact:true}).click();
  await page.locator('#program-body .program-link').waitFor();
  if(await page.locator('#program-route').inputValue()!=='TRANSPORT')throw new Error('Internal filter did not apply');
  await page.locator('#program-body .program-link').first().click();
  await page.locator('#detail-name').filter({hasText:'代理核心内部连接'}).waitFor();
  const detail=await page.locator('#detail-content').innerText();
  if(!detail.includes('旧记录未保存类型')||!detail.includes('Mihomo Inner（实时识别）'))throw new Error('Missing historical/live provenance');
  await page.locator('#detail-close').click();
  await page.locator('[data-page="connections"]').click();
  await page.locator('#connection-route').selectOption('TRANSPORT');
  await page.locator('#connection-body').getByText('内部转发',{exact:true}).first().waitFor();
  await page.locator('[data-page="overview"]').click();
  await page.setViewportSize({width:520,height:850});
  await page.screenshot({path:'qa-output/inner-accounting-narrow.png',fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow||errors.length)throw new Error(JSON.stringify({overflow,errors}));
  await page.setViewportSize({width:1440,height:1000});
  return {internalText,internalDetails:true,provenanceVisible:true,internalLiveFilter:true,rankingsExcludeInternal:true,narrowOverflow:overflow,pageErrors:errors};
}
