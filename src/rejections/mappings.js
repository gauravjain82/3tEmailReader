const mappings=require('./mappings.json');
function extractItemName(text){
  const compact=String(text||'').toUpperCase().replace(/\s/g,'').replace(/[\u2010-\u2015]/g,'-');
  const found=compact.match(/\d{5}M[A-Z0-9]{5}-?[0-9O]{3}/);
  if(!found)return '';
  const code=found[0].replace(/-?([0-9O]{3})$/,(_,suffix)=>'-'+suffix.replace(/O/g,'0'));
  if(Object.hasOwn(mappings.parts,code))return code;
  // Existing embedded OCR sometimes writes the numeric zero as O. Only use
  // that correction when it resolves to a supplied exact mapping.
  const corrected=code.replace(/O/g,'0');
  return Object.hasOwn(mappings.parts,corrected)?corrected:code;
}
function partNameForItem(item){
  const key=String(item||'').toUpperCase().replace(/\s/g,'');
  return Object.hasOwn(mappings.parts,key)?mappings.parts[key]:'';
}
function plantForLocation(text){
  const source=String(text||'').toUpperCase();
  const matched=Object.keys(mappings.plants).filter(city=>new RegExp('\\b'+city+'\\b').test(source));
  return matched.length===1?mappings.plants[matched[0]]:null;
}
module.exports={extractItemName,partNameForItem,plantForLocation};
