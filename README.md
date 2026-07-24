# 中国五级行政区划查询与下载平台

> 🌐 在线访问：https://map.ruiduobao.com  
> 📱 关注公众号「锐多宝」获取更多数据

## 简介

**gaode_MAP_CUN** 是一个免费的中国五级行政区划数据查询与下载平台，支持省、市、县、乡镇、村五级行政区划的**可视化浏览**和**矢量数据下载**。

## 核心功能

- 🗺️ **五级行政区划浏览** — 省→市→县→乡镇→村，树状层级导航
- 📊 **多年份历史数据** — 支持 2010/2017/2018/2021/2023 年数据切换
- 📦 **多格式矢量下载** — GeoJSON / Shapefile / KML / GeoPackage / SVG
- 🔍 **行政区划搜索** — 支持地名和编码搜索
- 📱 **移动端适配** — PC 端树状视图 + 移动端下拉选择器
- 🛰️ **多源卫星底图** — ESRI / 必应 / 星图地球 / 高德卫星路网

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 数据库 | PostgreSQL + PostGIS |
| 缓存 | Redis + LRU 内存缓存 |
| 前端 | EJS + 高德地图 API + markmap |
| 运维 | PM2 + OpenResty (Nginx) |

## 快速开始

### 环境要求

- Node.js >= 16
- PostgreSQL >= 14 + PostGIS
- Redis (可选，用于缓存)

### 安装

```bash
git clone https://github.com/ruiduobao/gaode_MAP_CUN.git
cd gaode_MAP_CUN
npm install
```

### 配置

复制 `.env.example` 为 `.env` 并修改数据库连接等配置：

```bash
cp .env.example .env
```

### 启动

```bash
# 开发模式
npm run dev

# 生产模式
npm start

# 使用 PM2 守护进程
pm2 start app.js --name map-ruiduobao
```

服务默认端口：**3003**

## 数据接口

### 树状数据 API

```
GET /api/tree/provinces?year=2023
GET /api/tree/cities?year=2023&province=四川省
GET /api/tree/counties?year=2023&province=四川省&city=成都市
GET /api/tree/towns?year=2023&province=四川省&city=成都市&county=锦江区
GET /api/tree/villages?year=2023&province=四川省&city=成都市&county=锦江区&town=春熙路街道
```

### 矢量数据 API

```
GET /getGsonDB?code=xxx           # 获取 GeoJSON 矢量数据
GET /downloadVector/:code?format=shp  # 下载指定格式矢量文件
GET /search?keyword=xxx           # 搜索行政区划
```

### 坐标查询

```
GET /getGsonDB/point-query?lng=104.06&lat=30.67&year=2023
```

## 数据说明

| 数据类型 | 来源 | 时效性 |
|----------|------|--------|
| 省市县边界 | 省市县数据 CTAmap | 2000-2023 年 |
| 乡镇边界 | 统计局普查数据 | 2020 年 |
| 村级点位 | 高德地图地理编码 | 约 2020 年 |

## 目录结构

```
gaode_MAP_CUN/
├── app.js              # 主入口文件
├── config/             # 配置文件
├── public/             # 静态资源
│   ├── css/            # 样式文件
│   ├── js/             # 前端脚本
│   ├── pics/           # 图片资源
│   ├── others/         # 辅助页面
│   └── nodepack/       # 前端 shp/dbf 库
├── routes/             # 路由模块
├── services/           # 业务逻辑层
├── views/              # EJS 模板
├── middleware/         # 中间件
├── scripts/            # 运维脚本
├── utils/              # 工具函数
├── year/               # 各省行政区划 HTML 页面（markmap 生成）
├── 省市县乡村的编码markdown/  # 行政区划 Markdown 数据
├── 处理脚本/            # 数据处理工具脚本
└── package.json
```

## 部署

详见 [开发指南.md](开发指南.md)，包含：

- Nginx 反向代理配置
- SSL 证书配置
- 数据库迁移指南
- 定时任务设置
- PM2 守护进程配置

## 更新日志

| 版本 | 日期 | 说明 |
|------|------|------|
| 3.12 | 2026-05-27 | 乡镇级批量下载、多格式支持、省份预缓存 |
| 3.10 | 2026-03-22 | 矢量样式优化 |
| 3.7 | 2026-03-19 | 批量下载优化、免责声明 |
| 3.6 | 2026-03-16 | 数据库连接池、LRU 缓存、SQL 优化 |
| 3.1 | 2026-03-14 | 下载功能修复、移动端优化 |
| 2.0 | 2026-03-13 | 多年份数据、搜索、KML/GeoPackage |

完整更新日志见 [开发指南.md](开发指南.md) 第二十章。

## 联系方式

- 🌐 网站：https://map.ruiduobao.com
- 📱 公众号：锐多宝
- 📧 邮箱：caaschengrui@163.com
- 🔗 更多数据：https://shengshixian.com

## 许可

本项目数据仅供参考，不保证完全准确。使用者需自行核实数据准确性，请遵守相关法律法规，合法使用数据。禁止用于商业目的。
