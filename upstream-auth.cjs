const fs = require('node:fs');
exports.key = () => {
  let value = process.env.OPENAI_API_KEY;
  if (!value) {
    try {value = fs.readFileSync(__dirname + '/upstream-api-key', 'utf8');}
    catch (error) {if (error.code !== 'ENOENT') throw new Error('Internal API key file cannot be read');}
  }
  if (!value) return null;
  value = value.trim();
  if (!value || /\s/.test(value)) throw new Error('Internal API key format is invalid');
  if (value === fs.readFileSync(__dirname + '/access-token', 'utf8').trim()) throw new Error('Internal and external keys must differ');
  return value;
};
exports.configured = () => {try {return Boolean(exports.key());} catch {return false;}};
