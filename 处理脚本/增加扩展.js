const fs = require('fs');
const path = require('path');

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

// 调用函数，传递目录路径和替换字符串
const PATH = process.env.DATA_DIR || "./data_example/生成的html文件";
replaceStringInHtmlFiles(PATH, '"children":[]}]}]}]}]},null', '"children":[]}]}]}]}]},{"initialExpandLevel":1}');
