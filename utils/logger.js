/**
 * 日志模块
 * 使用 pino 提供结构化日志
 */

const pino = require('pino');
const { config } = require('../config');

// 日志配置
const isDev = config.server.nodeEnv === 'development';

const transport = isDev
    ? {
          target: 'pino-pretty',
          options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname'
          }
      }
    : undefined;

const logger = pino({
    level: isDev ? 'debug' : 'info',
    transport,
    formatters: {
        level: (label) => ({ level: label.toUpperCase() })
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    base: {
        service: 'map-ruiduobao'
    }
});

// 创建子日志器（带上下文）
function createContextLogger(context) {
    return logger.child({ context });
}

module.exports = { logger, createContextLogger };