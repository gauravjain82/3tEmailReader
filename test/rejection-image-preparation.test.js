const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const {prepareField}=require('../src/rejections/imagePreparation');
const {selectReading,extractField}=require('../src/rejections/ocr');

test('preparation enlarges faint text and retains the original image bytes',async()=>{
  const canvas=createCanvas(180,60),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,180,60);
  ctx.fillStyle='#999999';ctx.font='28px sans-serif';ctx.fillText('1234.50',20,40);
  const source=canvas.toBuffer('image/png'),copy=Buffer.from(source);
  const result=await prepareField(source),image=await loadImage(result.buffer);
  assert.deepEqual(source,copy);assert.ok(image.width>canvas.width);assert.ok(image.height>canvas.height);
  const output=createCanvas(image.width,image.height),out=output.getContext('2d');out.drawImage(image,0,0);
  const pixels=out.getImageData(0,0,image.width,image.height).data;
  assert.ok(pixels.some((v,i)=>i%4===0&&v<80),'faint text is visible after contrast adjustment');
});

test('blank images remain blank instead of generating ink or a skew angle',async()=>{
  const canvas=createCanvas(100,40),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,100,40);
  const result=await prepareField(canvas.toBuffer('image/png'),{binary:true});assert.equal(result.angle,0);
  const image=await loadImage(result.buffer),check=createCanvas(image.width,image.height),out=check.getContext('2d');out.drawImage(image,0,0);
  assert.ok(out.getImageData(0,0,image.width,image.height).data.every(v=>v===255));
});

test('sparse ink survives when the background occupies both histogram percentiles',async()=>{
  const canvas=createCanvas(300,100),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,300,100);
  ctx.fillStyle='black';ctx.fillRect(100,40,3,12);
  const result=await prepareField(canvas.toBuffer('image/png'));
  const image=await loadImage(result.buffer),check=createCanvas(image.width,image.height),out=check.getContext('2d');out.drawImage(image,0,0);
  assert.ok(out.getImageData(0,0,image.width,image.height).data.some((v,i)=>i%4===0&&v<30));
});

test('image variants cannot hide conflicting engine readings or promote low-confidence alternatives',()=>{
  const variants=[{text:'5.00',confidence:95},{text:'6.00',confidence:85}];
  assert.match(selectReading('Qty',variants,'','tesseract').error,/conflicting/);
  assert.match(selectReading('Qty',variants,'','windows').error,/conflicting/);
  const selected=selectReading('Qty',[{text:'5.00',confidence:95},{text:'6.00',confidence:40}],'','tesseract');
  assert.equal(selected.text,'5.00');assert.equal(selected.attempts.length,2);
  const same=selectReading('Basic value',[{text:'1,234.50'},{text:'1234 50'}],'','windows');
  assert.equal(extractField('Basic value',same.text),'1234.50');assert.equal(same.error,undefined);
});
