const fs=require('fs');
const path=require('path');
const {partNameForItem}=require('./mappings');
function canonical(value){return typeof value==='string'?value.toUpperCase().replace(/\s/g,'').replace(/[\u2010-\u2015]/g,'-'):'';}
function needsPartCheck(document){return document.items?.some(i=>!partNameForItem(canonical(i.item_name))||i.uncertain_fields?.includes('item_name'));}
function reconcileParts(document,result){
  const revised=structuredClone(document),changes=[];
  for(let n=0;n<revised.items.length;n++){
    const item=revised.items[n];
    if(partNameForItem(canonical(item.item_name))&&!item.uncertain_fields?.includes('item_name'))continue;
    const readings=Array.isArray(result?.parts)?result.parts.filter(p=>p?.line===n+1):[];
    const reading=readings.length===1?readings[0]:null,table=canonical(reading?.table_part),material=canonical(reading?.material_part);
    const accepted=reading?.uncertain===false&&/^\d{5}M[A-Z0-9]{5}-\d{3}$/.test(table)&&table===material;
    const before=item.item_name;
    if(accepted){item.item_name=table;item.uncertain_fields=(item.uncertain_fields||[]).filter(f=>f!=='item_name');}
    else{item.item_name=null;item.uncertain_fields=[...new Set([...(item.uncertain_fields||[]),'item_name'])];}
    changes.push({line:n+1,before,tableReading:table,materialReading:material,after:item.item_name,status:accepted?'REPEATED_PRINT_AGREEMENT':'UNRESOLVED'});
  }
  return {document:revised,changes};
}
function stretchGray(pixels){
  const hist=new Uint32Array(256),count=pixels.length/4;
  for(let j=0;j<pixels.length;j+=4){const v=Math.round(.299*pixels[j]+.587*pixels[j+1]+.114*pixels[j+2]);hist[v]++;pixels[j]=pixels[j+1]=pixels[j+2]=v;}
  const percentile=q=>{let sum=0;for(let v=0;v<256;v++){sum+=hist[v];if(sum>=count*q)return v;}return 255;};
  const low=percentile(.02),high=percentile(.98);
  if(high-low>20)for(let j=0;j<pixels.length;j+=4){const v=Math.max(0,Math.min(255,Math.round((pixels[j]-low)*255/(high-low))));pixels[j]=pixels[j+1]=pixels[j+2]=v;}
}
function createPartCrops(data,output,prefix){
  let parser,lastPage,lastImage;
  async function render(page,regions=[{label:'Part-number column in the item table',name:'table',x:.06,y:.37,w:.28,h:.19},{label:'Repeated part number in the Material section below the table',name:'material',x:.06,y:.56,w:.28,h:.16}]){
    const {PDFParse}=require('pdf-parse'),{createCanvas,loadImage}=require('@napi-rs/canvas');
    parser ||= new PDFParse({data:new Uint8Array(data)});
    if(lastPage!==page){const rendered=(await parser.getScreenshot({partial:[page],scale:5,imageBuffer:true,imageDataUrl:false})).pages[0];lastImage=await loadImage(rendered.data);lastPage=page;}
    const image=lastImage;
    const folder=path.join(output,'gemini-part-crops');fs.mkdirSync(folder,{recursive:true});
    const images=[];
    for(const box of regions){
      const canvas=createCanvas(Math.ceil(image.width*box.w),Math.ceil(image.height*box.h)),ctx=canvas.getContext('2d');
      ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,image.width*box.x,image.height*box.y,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
      const original=path.join(folder,`${prefix}-page-${page}-${box.name}.original.png`);fs.writeFileSync(original,canvas.toBuffer('image/png'));
      // Stretch grayscale contrast without replacing or generating any characters.
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);stretchGray(pixels.data);
      ctx.putImageData(pixels,0,0);
      const buffer=canvas.toBuffer('image/png'),file=path.join(folder,`${prefix}-page-${page}-${box.name}.png`);fs.writeFileSync(file,buffer);
      images.push({label:box.label,buffer,mimeType:'image/png',file,original,region:box});
    }
    return images;
  }
  return {render,renderHeader:page=>render(page,[{label:'Enlarged printed supplier/invoice header from the same PDF page',name:'header',x:.08,y:.19,w:.72,h:.14},{label:'Enlarged top handwritten acknowledgement from the same PDF page',name:'acknowledgement',x:.06,y:.055,w:.38,h:.14}]),close:async()=>{lastImage=null;await parser?.destroy();}};
}
module.exports={canonical,needsPartCheck,reconcileParts,createPartCrops,stretchGray};
