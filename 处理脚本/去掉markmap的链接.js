const path = require('path');
const fs = require('fs-extra');

// 替换指定目录下的所有HTML文件
const replaceInDir = async (dir) => {
    const files = await fs.readdir(dir);
    
    for (const file of files) {
        const filepath = path.join(dir, file);
        const stats = await fs.stat(filepath);
        
        if (stats.isDirectory()) {
            await replaceInDir(filepath);
        } else if (path.extname(file) === '.html') {
            let content = await fs.readFile(filepath, 'utf-8');
            const targetStr1 = "el.setAttribute('style', 'position:absolute;bottom:20px;right:20px');";
            const targetStr2 = "document.body.append(el);";

            if (content.includes(targetStr1) && content.includes(targetStr2)) {
                content = content.replace(targetStr1, `<!-- ${targetStr1} -->`);
                content = content.replace(targetStr2, `<!-- ${targetStr2} -->`);
                await fs.writeFile(filepath, content);
                console.log(`Updated: ${filepath}`);
            }
        }
    }
}

// 请将以下目录替换为你的HTML文件目录
const targetDir = process.env.YEAR_DATA_DIR || './year/2023年'; 

replaceInDir(targetDir)
    .then(() => console.log('Done'))
    .catch(error => console.error(error));
