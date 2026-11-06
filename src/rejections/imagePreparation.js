// Pixel-only OCR preparation. No generated text or source-PDF changes.
const {createCanvas,loadImage}=require('@napi-rs/canvas');
async function prepareField(input,{binary=false,deskew=true}={}){
  const image=await loadImage(input),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),{width:w,height:h}=canvas;
  const hist=new Uint32Array(256),grey=new Uint8Array(w*h);
  for(let p=0;p<grey.length;p++){const j=p*4;grey[p]=Math.round(.299*pixels.data[j]+.587*pixels.data[j+1]+.114*pixels.data[j+2]);hist[grey[p]]++;}
  const percentile=q=>{let sum=0;for(let n=0;n<256;n++){sum+=hist[n];if(sum>=grey.length*q)return n;}return 255;};
  const low=percentile(.01),high=percentile(.95);
  if(high-low>=30)for(let p=0;p<grey.length;p++)grey[p]=Math.max(0,Math.min(255,Math.round((grey[p]-low)*255/(high-low))));
  // Remove rules spanning almost the entire crop; character strokes are shorter.
  const columns=[],rows=[];
  for(let x=0;x<w;x++){let count=0;for(let y=0;y<h;y++)if(grey[y*w+x]<160)count++;if(count>h*.85)columns.push(x);}
  for(let y=0;y<h;y++){let count=0;for(let x=0;x<w;x++)if(grey[y*w+x]<160)count++;if(count>w*.85)rows.push(y);}
  for(const x of columns)for(let y=0;y<h;y++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<w)grey[y*w+x+dx]=255;
  for(const y of rows)for(let x=0;x<w;x++)for(let dy=-1;dy<=1;dy++)if(y+dy>=0&&y+dy<h)grey[(y+dy)*w+x]=255;
  const points=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(grey[y*w+x]<150)points.push([x,y]);
  let angle=0,best=0,baseline=0;
  if(deskew&&points.length>20)for(let a=-4;a<=4;a+=.5){
    const r=a*Math.PI/180,projection=new Uint32Array(h+w+4);
    for(const [x,y]of points)projection[Math.round(x*Math.sin(r)+y*Math.cos(r))+Math.ceil(w/2)]++;
    const score=projection.reduce((sum,n)=>sum+n*n,0);
    if(a===0)baseline=score;if(score>best){best=score;angle=a;}
  }
  if(best<baseline*1.02)angle=0;
  for(let p=0;p<grey.length;p++){const v=binary?(grey[p]<175?0:255):grey[p],j=p*4;pixels.data[j]=pixels.data[j+1]=pixels.data[j+2]=v;pixels.data[j+3]=255;}
  ctx.putImageData(pixels,0,0);
  const scale=2,padding=16,margin=Math.ceil(Math.max(w,h)*.08);
  const output=createCanvas((w+margin*2)*scale+padding*2,(h+margin*2)*scale+padding*2),target=output.getContext('2d');
  target.fillStyle='white';target.fillRect(0,0,output.width,output.height);
  target.translate(output.width/2,output.height/2);target.rotate(angle*Math.PI/180);target.scale(scale,scale);target.drawImage(canvas,-w/2,-h/2);
  return {buffer:output.toBuffer('image/png'),angle,scale,binary,width:output.width,height:output.height};
}
module.exports={prepareField};
