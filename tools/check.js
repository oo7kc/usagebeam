import {checkRepository} from './repositoryChecks.js';
import {checkJavaScript, checkPython, listFiles} from './sourceChecks.js';

const sourceFiles = ['extension.js', 'prefs.js', ...listFiles('src'), ...listFiles('tests'), ...listFiles('tools')];
const javascriptFiles = sourceFiles.filter(file => file.endsWith('.js'));
const pythonFiles = sourceFiles.filter(file => file.endsWith('.py'));

checkJavaScript(javascriptFiles);
checkPython(pythonFiles);
checkRepository();

console.log(`Syntax, named imports, architecture, dependency cycles, formatting, repository layout, links, release metadata and schema checks passed (${javascriptFiles.length} JavaScript files).`);
