const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const bodyParser = require('body-parser');

// 初始化应用
const app = express();
const server = http.createServer(app);
// 不指定path，使WebSocket服务器支持所有路径的连接请求
const wss = new WebSocket.Server({ 
  server,
  // 客户端信息处理选项
  clientTracking: true
});

// 配置中间件
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.json());

// 读取配置文件
let config;
try {
  config = require('../config.json');
} catch (err) {
  console.error('配置文件读取失败，使用默认配置', err);
  config = {
    server: {
      port: 8833,
      enableNotifications: true,
      autoPlayNext: true,
      networkDelayThreshold: 600
    },
    videos: [],
    currentVideo: { id: null, position: 0, playing: false }
  };
}

// 用户连接状态
let connections = [];
let connectedUsers = 0;
let configSaveTimer = null;

// 日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // 写入日志文件
  fs.appendFileSync(path.join(__dirname, '../server.log'), logMessage + '\n', { flag: 'a' });
}

// 保存配置
function saveConfig() {
  fs.writeFileSync(path.join(__dirname, '../config.json'), JSON.stringify(config, null, 2));
  log('配置已更新');
}

// 启动自动保存配置的定时器（每10分钟）
function startConfigSaveTimer() {
  if (configSaveTimer === null) {
    log('启动配置自动保存定时器（10分钟）');
    configSaveTimer = setInterval(saveConfig, 10 * 60 * 1000);
  }
}

// 停止自动保存配置的定时器
function stopConfigSaveTimer() {
  if (configSaveTimer !== null) {
    log('停止配置自动保存定时器');
    clearInterval(configSaveTimer);
    configSaveTimer = null;
  }
}

// 向所有客户端广播消息
function broadcast(type, data, excludeClient = null) {
  const message = JSON.stringify({ type, data });
  
  wss.clients.forEach(client => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 处理WebSocket连接
wss.on('connection', (ws, req) => {
  // 获取客户端IP地址
  const ip = getClientIp(req);
  ws.clientIp = ip; // 将IP地址保存到WS对象上，便于后续访问
  ws.connectedAt = Date.now(); // 记录连接时间
  
  const isFirstUser = connectedUsers === 0;
  connectedUsers++;
  connections.push(ws);
  
  log(`新用户连接, IP: ${ip}, 当前在线: ${connectedUsers}人, 是否为第一个用户: ${isFirstUser}`);
  
  // 如果是第一个用户连接，启动定时保存
  if (isFirstUser) {
    startConfigSaveTimer();
  }
  
  // 发送当前状态
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      videos: config.videos,
      currentVideo: config.currentVideo,
      connectedUsers,
      isFirstUser
    }
  }));
  
  // 如果不是第一个用户，且有其他用户正在观看，立即同步当前播放状态
  if (!isFirstUser && connectedUsers > 1 && config.currentVideo.id) {
    // 立即发送当前播放状态
    ws.send(JSON.stringify({
      type: 'syncState',
      data: {
        ...config.currentVideo,
        timestamp: Date.now() // 添加时间戳以确保状态是最新的
      }
    }));
    log(`向新用户同步当前播放状态: ${JSON.stringify(config.currentVideo)}`);
  }
  
  // 通知其他用户
  if (config.server.enableNotifications) {
    // 不再对IP地址进行模糊处理
    broadcast('notification', {
      message: `来自 ${ip} 的用户加入，当前共${connectedUsers}人在线`,
      users: connectedUsers
    }, ws);
  }
  
  // 处理客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'play':
          config.currentVideo.playing = true;
          config.currentVideo.position = data.data.position;
          broadcast('play', { position: data.data.position }, ws);
          log(`播放视频，位置: ${data.data.position}`);
          break;
          
        case 'pause':
          config.currentVideo.playing = false;
          config.currentVideo.position = data.data.position;
          broadcast('pause', { position: data.data.position }, ws);
          log(`暂停视频，位置: ${data.data.position}`);
          break;
          
        case 'userLeave':
          // 只保存播放位置，不广播pause消息
          config.currentVideo.position = data.data.position;
          log(`用户离开，保存播放位置: ${data.data.position}`);
          break;
          
        case 'seek':
          config.currentVideo.position = data.data.position;
          broadcast('seek', { position: data.data.position }, ws);
          log(`跳转到: ${data.data.position}`);
          break;
          
        case 'changeVideo':
          const videoId = data.data.videoId;
          const videoToPlay = config.videos.find(v => v.id === videoId);
          
          if (videoToPlay) {
            config.currentVideo.id = videoId;
            config.currentVideo.position = data.data.startPosition || 0;
            config.currentVideo.playing = true;
            
            broadcast('changeVideo', {
              videoId,
              position: config.currentVideo.position,
              playing: true
            });
            
            log(`切换视频: ${videoToPlay.name}`);
          }
          break;
          
        case 'heartbeat':
          // 处理心跳包，更新客户端延迟
          ws.send(JSON.stringify({
            type: 'heartbeat',
            data: { timestamp: Date.now() }
          }));
          break;
          
        case 'playerReady':
          // 处理播放器准备好的消息，如果不是第一个用户则同步当前视频状态
          if (!isFirstUser && config.currentVideo.id) {
            // 获取当前正在播放的用户的状态
            let currentState = null;
            for (const conn of connections) {
              if (conn !== ws && conn.currentState) {
                currentState = conn.currentState;
                break;
              }
            }
            
            // 如果找到了当前状态，发送给新用户
            if (currentState) {
              ws.send(JSON.stringify({
                type: 'syncState',
                data: {
                  ...currentState,
                  timestamp: Date.now()
                }
              }));
              log(`向新用户同步实时播放状态: ${JSON.stringify(currentState)}`);
            } else {
              // 如果没有找到当前状态，使用配置中的状态
              ws.send(JSON.stringify({
                type: 'syncState',
                data: config.currentVideo
              }));
              log(`向新用户同步配置状态: ${JSON.stringify(config.currentVideo)}`);
            }
          }
          break;
          
        case 'updateState':
          // 更新当前用户的播放状态
          ws.currentState = {
            id: config.currentVideo.id,
            position: data.data.position,
            playing: data.data.playing
          };
          break;
      }
      
    } catch (err) {
      log(`处理消息出错: ${err.message}`);
    }
  });
  
  // 处理断开连接
  ws.on('close', () => {
    connectedUsers--;
    connections = connections.filter(conn => conn !== ws);
    
    log(`用户断开连接, IP: ${ws.clientIp}, 当前在线: ${connectedUsers}人`);
    
    // 当所有用户都离开时，保存当前状态并停止定时器
    if (connectedUsers === 0) {
      log('所有用户已离开，保存当前播放状态');
      saveConfig();
      stopConfigSaveTimer();
    }
    
    if (config.server.enableNotifications) {
      // 不再对IP地址进行模糊处理
      broadcast('notification', {
        message: `来自 ${ws.clientIp} 的用户离开，当前共${connectedUsers}人在线`,
        users: connectedUsers
      });
    }
  });
});

// API 路由
app.get('/api/videos', (req, res) => {
  res.json(config.videos);
});

// 管理员API: 获取当前连接的客户端信息
app.get('/api/admin/connections', (req, res) => {
  // 简单的API密钥验证
  const apiKey = req.query.key || '';
  
  if (!apiKey || apiKey !== 'admin123') { // 建议使用环境变量或配置文件中的强密码
    return res.status(403).json({ error: '无权访问' });
  }
  
  const clientInfo = connections.map((conn, index) => {
    return {
      id: index + 1,
      ip: conn.clientIp,
      connected: new Date(conn.connectedAt || Date.now()).toISOString(),
      current: conn.currentState ? {
        videoId: conn.currentState.id,
        position: conn.currentState.position,
        playing: conn.currentState.playing
      } : null
    };
  });
  
  res.json({
    total: connectedUsers,
    clients: clientInfo
  });
});

app.post('/api/videos', (req, res) => {
  const video = req.body;
  
  if (!video.name || !video.url) {
    return res.status(400).json({ error: '视频名称和URL是必需的' });
  }
  
  // 生成唯一ID
  video.id = Date.now().toString();
  video.lastPlayTime = 0;
  
  config.videos.push(video);
  saveConfig();
  
  // 通知所有客户端
  broadcast('newVideo', { video });
  
  log(`添加新视频: ${video.name}`);
  res.json(video);
});

app.delete('/api/videos/:id', (req, res) => {
  const id = req.params.id;
  const index = config.videos.findIndex(v => v.id === id);
  
  if (index !== -1) {
    const deletedVideo = config.videos[index];
    config.videos.splice(index, 1);
    saveConfig();
    
    // 如果删除的是当前正在播放的视频，切换到下一个视频
    if (config.currentVideo.id === id) {
      if (config.videos.length > 0) {
        config.currentVideo.id = config.videos[0].id;
        config.currentVideo.position = 0;
        
        broadcast('changeVideo', {
          videoId: config.currentVideo.id,
          position: 0,
          playing: false
        });
      } else {
        config.currentVideo.id = null;
        config.currentVideo.position = 0;
        config.currentVideo.playing = false;
        
        broadcast('stop', {});
      }
    }
    
    // 通知所有客户端视频已被删除
    broadcast('notification', {
      message: `视频"${deletedVideo.name}"已被删除`,
      users: connectedUsers
    });
    
    // 广播删除视频的消息
    broadcast('videoDeleted', { videoId: id });
    
    log(`删除视频: ${id}, 名称: ${deletedVideo.name}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '未找到视频' });
  }
});

// 启动服务器
const PORT = config.server.port || 8833;
server.listen(PORT, () => {
  const ipAddresses = getIpAddresses();
  
  log('========================================');
  log(`服务器启动成功，端口: ${PORT}`);
  log('----------------------------------------');
  log('HTTP 服务访问地址:');
  log(`本地访问: http://localhost:${PORT}`);
  ipAddresses.forEach(ip => {
    log(`网络访问: http://${ip}:${PORT}`);
  });
  
  log('----------------------------------------');
  log('WebSocket 服务连接地址:');
  log(`本地连接: ws://localhost:${PORT}`);
  ipAddresses.forEach(ip => {
    log(`网络连接: ws://${ip}:${PORT}`);
  });
  log('WebSocket 服务支持所有路径的连接请求');
  log('----------------------------------------');
  log(`配置文件: ${path.resolve(__dirname, '../config.json')}`);
  log('========================================');
});

// 获取服务器IP地址
function getIpAddresses() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // 跳过内部和非IPv4地址
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  
  return results;
}

// 获取客户端真实IP地址的函数
function getClientIp(req) {
  // 尝试从各种HTTP头中获取真实IP
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    // X-Forwarded-For格式通常是: client, proxy1, proxy2, ...
    // 取第一个IP地址作为客户端IP
    return xForwardedFor.split(',')[0].trim();
  } 
  
  if (req.headers['x-real-ip']) {
    return req.headers['x-real-ip'];
  }
  
  // 如果以上头信息都没有，则从socket连接中获取
  const socketAddress = req.socket.remoteAddress;
  // 处理IPv6格式，如::ffff:192.168.0.1
  return socketAddress.replace(/^::ffff:/, '');
} 