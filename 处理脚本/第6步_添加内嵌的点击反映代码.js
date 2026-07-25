const fs = require('fs');
const path = require('path');

// 定义要操作的文件夹路径
const targetDir = process.env.DATA_DIR || "./data/生成的html文件/首页";

// 定义替换的新内容
const newContent = `<body>
<script>
    function sendToParent(type, value)  {
    let message = {};
    if(type === "code") {
        message = {
            "type": "updateMapByCode",
            "code": value
        };
    } else if(type === "address") {
        message = {
            "type": "updateMapByAddress",
            "address": value
        };
    }
    window.parent.postMessage(message, '*');
    }
    // 为父元素添加事件代理
    document.body.addEventListener('click', function(event) {
    if (event.target.tagName === 'A') {
        event.preventDefault();

        if (event.target.hasAttribute('data-code')) {
            const dataCode = event.target.getAttribute('data-code');
            sendToParent("code", dataCode);
        } else if (event.target.hasAttribute('data-address')) {
            const dataAddress = event.target.getAttribute('data-address');
            sendToParent("address", dataAddress);
        }
        }
    });
</script>`;

// 读取文件夹中的所有文件
fs.readdir(targetDir, (err, files) => {
    if (err) throw err;

    // 过滤出 HTML 文件
    const htmlFiles = files.filter(file => path.extname(file) === '.html');

    htmlFiles.forEach(file => {
        const filePath = path.join(targetDir, file);

        // 读取每个 HTML 文件
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) throw err;

            // 替换 <body> 标签
            const updatedData = data.replace('<body>', newContent);

            // 将更新的内容写回文件
            fs.writeFile(filePath, updatedData, 'utf8', err => {
                if (err) throw err;
                console.log(`Updated ${file}`);
            });
        });
    });
});
