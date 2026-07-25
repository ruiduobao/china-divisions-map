//添加扩展级别
//删掉markmap标识
const path = require('path');
const fsEX = require('fs-extra');
const { Glob } = require('glob');
// 调用函数，传递目录路径和替换字符串
const fs = require('fs');
// const path = require('path');

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function replaceStringInHtmlFiles(directoryPath, oldString, newString) {
    // 读取目录中的所有文件
    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            return console.log('Unable to scan directory: ' + err);
        }
        // 遍历所有文件
        files.forEach(file => {
            const filePath = path.join(directoryPath, file);
            // 检查文件是否为HTML文件
            if (path.extname(filePath) === '.html') {
                // 读取文件内容
                fs.readFile(filePath, 'utf8', (err, data) => {
                    if (err) {
                        return console.log('Unable to read file: ' + err);
                    }
                    // 替换字符串
                    const updatedData = data.replace(new RegExp(escapeRegExp(oldString), 'g'), newString);
                    // 将更新的内容写回文件
                    fs.writeFile(filePath, updatedData, 'utf8', err => {
                        if (err) {
                            return console.log('Error writing file: ' + err);
                        }
                        console.log('Updated: ', filePath);
                    });
                });
            }
        });
    });
}

// 替换指定目录下的所有HTML文件
// 除掉html的markmap标识
const replaceInDir = async (dir) => {
    const files = await fsEX.readdir(dir);
    
    for (const file of files) {
        const filepath = path.join(dir, file);
        const stats = await fsEX.stat(filepath);
        
        if (stats.isDirectory()) {
            await replaceInDir(filepath);
        } else if (path.extname(file) === '.html') {
            let content = await fsEX.readFile(filepath, 'utf-8');
            const targetStr1 = "el.setAttribute('style', 'position:absolute;bottom:20px;right:20px');";
            const targetStr2 = "document.body.append(el);";

            if (content.includes(targetStr1) && content.includes(targetStr2)) {
                content = content.replace(targetStr1, `<!-- ${targetStr1} -->`);
                content = content.replace(targetStr2, `<!-- ${targetStr2} -->`);
                await fsEX.writeFile(filepath, content);
                console.log(`Updated: ${filepath}`);
            }
        }
    }
}

const targetDir = process.env.DATA_DIR || "./data/生成的html文件/首页";

//  除掉html的markmap标识
//targetDir是异步函数，把replaceStringInHtmlFiles放到replaceInDir之后，使用then
replaceInDir(targetDir)
    .then(() => { 
        console.log('replaceInDir Done');
        replaceStringInHtmlFiles(targetDir, '"children":[]}]}]}]}]},null', '"children":[]}]}]}]}]},{"initialExpandLevel":1}');
    })
    .catch(error => console.error(error));


