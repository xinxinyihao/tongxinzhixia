// 全局变量
let player = null;
let ws = null;
let currentVideoId = null;
let networkDelay = 0;
let lastHeartbeat = Date.now();
let ignoreSeek = false;
let ignorePlayPause = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let isFirstUser = false;
let pendingVideoState = null; // 用于存储待处理的视频状态

// 连接状态元素
const statusIndicator = document.querySelector('.status-indicator');
const statusText = document.querySelector('.status-text');
const userCount = document.querySelector('.user-count');
const delayValue = document.querySelector('.delay-value');

// 播放器控制元素
const videoTitle = document.querySelector('.video-title');
const videoList = document.getElementById('video-list');
const notificationArea = document.getElementById('notification-area');

// 添加视频相关元素
const addVideoBtn = document.getElementById('add-video-btn');
const addVideoModal = document.getElementById('add-video-modal');
const closeModal = document.querySelector('.close-modal');
const addVideoForm = document.getElementById('add-video-form');

// 初始化函数
function init() {
  connectWebSocket();
  initEventListeners();
  
  // 开始发送心跳包
  setInterval(sendHeartbeat, 5000);
}

// 初始化播放器
function initPlayer(initialVideo = null) {
  const playerOptions = {
    container: '#artplayer-container',
    url: initialVideo ? initialVideo.url : '',
    poster: '',
    volume: 0.8,
    isLive: false,
    muted: false,
    autoplay: false,
    autoSize: true,
    autoMini: true,
    loop: false,
    flip: true,
    playbackRate: true,
    aspectRatio: true,
    screenshot: true,
    setting: true,
    hotkey: true,
    pip: true,
    mutex: true,
    fullscreen: true,
    fullscreenWeb: true,
    airplay: true, // 添加airplay支持
    fastForward: true, // 移动设备快进支持
    autoPlayback: true, // 允许记住播放位置
    autoOrientation: true, // 自动调整屏幕方向
    theme: '--primary-color', // 使用主题颜色
    layers: [],
    contextmenu: [],
    settings: [], // 移除画质切换选项
    moreVideoAttr: {
      // 增加视频属性，尝试解决移动设备自动播放问题
      'playsinline': true,
      'webkit-playsinline': true,
      'x5-playsinline': true, // 腾讯X5内核浏览器
      'x5-video-player-type': 'h5', // 腾讯X5内核H5播放器
      'x5-video-player-fullscreen': false,
      'x5-video-orientation': 'portraint'
    },
    // 设置弹窗定位修复
    cssVar: {
      '--art-subtitle-offset': '100px',
      '--art-control-height': '50px',
      '--art-settings-max-height': '300px'
    }
  };
  
  try {
    player = new Artplayer(playerOptions);
    
    // 添加自定义UI修复
    const fixPlayerUI = () => {
      // 针对设置按钮点击的修复
      const settingBtn = document.querySelector('.art-settings-icon');
      if (settingBtn) {
        const originalClick = settingBtn.onclick;
        settingBtn.onclick = function(e) {
          if (originalClick) {
            originalClick.call(this, e);
          }
          
          // 强制设置菜单位置
          setTimeout(() => {
            const settingsEl = document.querySelector('.art-settings');
            if (settingsEl) {
              const controlsRect = document.querySelector('.art-controls').getBoundingClientRect();
              settingsEl.style.bottom = `${controlsRect.height + 25}px`; // 调整距离
              settingsEl.style.top = 'auto';
              settingsEl.style.right = '20px';
              settingsEl.style.left = 'auto';
              settingsEl.style.transform = 'none';
              
              // 调整菜单宽度和高度
              const settingsBody = settingsEl.querySelector('.art-settings-body');
              if (settingsBody) {
                // 根据内容自适应宽度
                settingsBody.style.width = 'auto';
                settingsBody.style.minWidth = '120px';
                settingsBody.style.maxWidth = '200px';
              }
              
              // 确保所有设置项文字正常显示
              const settingsItems = settingsEl.querySelectorAll('.art-settings-item');
              settingsItems.forEach(item => {
                item.style.textAlign = 'left';
                item.style.padding = '6px 10px';
                item.style.margin = '0';
                item.style.whiteSpace = 'nowrap';
              });
            }
          }, 0);
        };
      }
    };
    
    // 当播放器准备好后应用UI修复
    player.on('ready', fixPlayerUI);
    
    // 播放器事件监听
    player.on('play', () => {
      console.log('播放事件触发');
      if (!ignorePlayPause) {
        sendMessage('play', { position: player.currentTime });
      }
      ignorePlayPause = false;
      updatePlayerState();
    });
    
    // 修复设置菜单位置
    player.on('setting:show', () => {
      const settingsEl = document.querySelector('.art-settings');
      if (settingsEl) {
        const controlsRect = document.querySelector('.art-controls').getBoundingClientRect();
        const artHeight = player.height;
        
        // 确保设置菜单显示在控制栏上方
        settingsEl.style.bottom = `${controlsRect.height + 25}px`; // 调整距离
        settingsEl.style.top = 'auto';
      }
    });
    
    player.on('pause', () => {
      console.log('暂停事件触发');
      if (!ignorePlayPause) {
        sendMessage('pause', { position: player.currentTime });
      }
      ignorePlayPause = false;
      updatePlayerState();
    });
    
    player.on('seek', () => {
      console.log('跳转事件触发');
      if (!ignoreSeek) {
        sendMessage('seek', { position: player.currentTime });
      }
      ignoreSeek = false;
      updatePlayerState();
    });
  
    // 检测移动设备浏览器
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
      console.log('检测到移动设备:', navigator.userAgent);
      addNotification('检测到移动设备，正在优化播放体验...');
    }
    
    // 增加播放出错事件处理
    player.on('error', (error) => {
      console.error('播放器错误:', error);
      addNotification('播放器发生错误，尝试重新连接...');
      
      // 尝试重置播放器
      setTimeout(() => {
        if (player && currentVideoId) {
          const videoItem = Array.from(videoList.children).find(item => item.dataset.id === currentVideoId);
          if (videoItem) {
            player.url = videoItem.dataset.url;
          }
        }
      }, 2000);
    });
  
    player.on('video:ended', () => {
      // 自动播放下一个视频的逻辑
      const videos = Array.from(videoList.children);
      if (videos.length > 1 && currentVideoId) {
        const currentIndex = videos.findIndex(item => item.dataset.id === currentVideoId);
        if (currentIndex !== -1 && currentIndex < videos.length - 1) {
          const nextVideo = videos[currentIndex + 1];
          playVideo(nextVideo.dataset.id);
        }
      }
    });
    
    // 定期更新播放状态
    startStateUpdateInterval();
    
    // 当播放器准备好时通知服务器
    player.on('ready', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendMessage('playerReady', {});
        console.log('播放器准备就绪，通知服务器');
        
        // 如果有待处理的状态，应用它
        if (pendingVideoState) {
          applyVideoState(pendingVideoState);
          pendingVideoState = null;
        }
      }
    });
    
    // 如果初始化时提供了视频，设置初始状态
    if (initialVideo && initialVideo.currentVideo && initialVideo.currentVideo.id) {
      // 将视频状态保存到待处理状态，等待ready事件后应用
      pendingVideoState = initialVideo;
    }
  } catch (error) {
    console.error('播放器初始化失败:', error);
    addNotification('播放器初始化失败，请刷新页面重试');
  }
}

// 更新播放器状态
function updatePlayerState() {
  if (player && player.isReady && currentVideoId) {
    // 避免过于频繁的状态更新
    if (!updatePlayerState.lastUpdate || Date.now() - updatePlayerState.lastUpdate > 1000) {
      updatePlayerState.lastUpdate = Date.now();
      
      try {
        sendMessage('updateState', {
          position: player.currentTime,
          playing: player.playing
        });
      } catch (error) {
        console.error('更新播放状态失败:', error);
      }
    }
  }
}

// 应用视频状态
function applyVideoState(state) {
  if (!player || !state.currentVideo) return;
  
  console.log('应用视频状态:', state);
  
  try {
    // 设置播放位置
    ignoreSeek = true;
    player.seek = state.currentVideo.position;
    
    // 设置播放/暂停状态
    if (state.currentVideo.playing) {
      ignorePlayPause = true;
      
      // 在移动设备上，可能需要用户交互才能开始播放
      const playPromise = player.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn('自动播放失败:', error);
          addNotification('请点击播放器开始播放');
          
          // 添加点击一次播放器区域自动开始播放的逻辑
          const playerContainer = document.getElementById('artplayer-container');
          const startPlayback = function() {
            player.play();
            playerContainer.removeEventListener('click', startPlayback);
          };
          
          playerContainer.addEventListener('click', startPlayback);
        });
      }
    } else {
      ignorePlayPause = true;
      player.pause();
    }
    
    addNotification('已应用保存的播放状态');
  } catch (error) {
    console.error('应用视频状态失败:', error);
    addNotification('同步状态时出现错误，请刷新重试');
  }
}

// 连接WebSocket
function connectWebSocket() {
  // 根据当前站点动态确定WebSocket的地址
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname || 'localhost';
  
  // 获取当前主机和端口
  const currentHost = host;
  const currentPort = window.location.port;
  
  let wsUrl = '';
  // 如果当前是在浏览器中通过标准端口（80/443）访问，则使用路径方式
  if (currentPort === '' || currentPort === '80' || currentPort === '443') {
    // 域名访问模式，使用ws路径
    wsUrl = `${protocol}//${currentHost}/ws`;
    console.log('使用路径方式连接WebSocket (域名访问模式)');
  } else {
    // 本地开发模式，使用固定端口8833
    const wsPort = 8833;
    wsUrl = `${protocol}//${currentHost}:${wsPort}`;
    console.log('使用端口方式连接WebSocket (本地开发模式)');
    console.log('当前页面端口:', currentPort, '连接WebSocket端口:', wsPort);
  }
  
  console.log('WebSocket连接地址:', wsUrl);
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket连接成功');
    setConnectionStatus(true);
    reconnectAttempts = 0;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };
  
  ws.onmessage = (event) => {
    handleMessage(JSON.parse(event.data));
  };
  
  ws.onclose = () => {
    console.log('WebSocket连接关闭');
    setConnectionStatus(false);
    
    // 重连逻辑
    if (reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      console.log(`将在 ${delay}ms 后尝试重连...`);
      
      reconnectTimeout = setTimeout(() => {
        reconnectAttempts++;
        connectWebSocket();
      }, delay);
    } else {
      addNotification('服务器连接失败，请刷新页面重试');
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket错误:', error);
    setConnectionStatus(false);
  };
}

// 发送WebSocket消息
function sendMessage(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// 设置连接状态
function setConnectionStatus(connected) {
  if (connected) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = '已连接';
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = '连接断开';
  }
}

// 处理收到的消息
function handleMessage(message) {
  console.log('收到消息:', message);
  
  // 检查播放器是否存在且就绪
  const isPlayerReady = player && player.isReady;
  
  switch (message.type) {
    case 'init':
      // 初始化数据
      isFirstUser = message.data.isFirstUser;
      userCount.textContent = message.data.connectedUsers;
      
      // 如果有当前播放的视频，先设置当前视频ID
      if (message.data.currentVideo && message.data.currentVideo.id) {
        currentVideoId = message.data.currentVideo.id;
      }
      
      // 渲染视频列表
      renderVideoList(message.data.videos);
      
      // 如果有当前播放的视频，设置播放器
      if (message.data.currentVideo && message.data.currentVideo.id) {
        const video = message.data.videos.find(v => v.id === message.data.currentVideo.id);
        if (video) {
          videoTitle.textContent = video.name;
          
          // 如果播放器尚未初始化，则初始化它
          if (!player) {
            // 创建初始视频对象
            const initialVideo = {
              url: video.url,
              currentVideo: message.data.currentVideo
            };
            
            // 初始化播放器并传入初始视频
            initPlayer(initialVideo);
          } else {
            // 播放器已存在，直接更新URL
            player.url = video.url;
            
            // 存储状态以待播放器ready后应用
            pendingVideoState = {
              currentVideo: message.data.currentVideo
            };
            
            // 如果播放器已就绪，立即应用状态
            if (isPlayerReady) {
              applyVideoState(pendingVideoState);
              pendingVideoState = null;
            }
          }
        }
      } else {
        // 没有当前视频，初始化空播放器
        if (!player) {
          initPlayer();
        }
      }
      break;
      
    case 'syncState':
      // 同步当前播放状态（对于非第一个用户）
      if (!isFirstUser) {
        // 如果当前没有播放视频，但有其他用户正在播放，直接同步到该视频
        if (message.data.id && (!currentVideoId || currentVideoId !== message.data.id)) {
          currentVideoId = message.data.id;
          const video = Array.from(videoList.children).find(item => item.dataset.id === message.data.id);
          if (video) {
            // 使用视频标题元素获取文本内容
            const titleElement = video.querySelector('.video-title-text');
            videoTitle.textContent = titleElement ? titleElement.textContent : video.dataset.id;
            
            // 记录当前要同步的状态
            const syncState = {
              currentVideo: message.data
            };
            
            // 在移动设备上，可能需要用户交互才能播放视频
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            if (isMobile && message.data.playing) {
              addNotification('点击播放器区域开始播放');
            }
            
            // 设置URL并存储待处理状态
            player.url = video.dataset.url;
            pendingVideoState = syncState;
            
            // 如果播放器已就绪，尝试立即应用状态
            if (isPlayerReady) {
              setTimeout(() => {
                applyVideoState(pendingVideoState);
                pendingVideoState = null;
              }, 500); // 给视频加载一些时间
            }
          }
        } else if (message.data.id === currentVideoId) {
          // 如果是同一个视频，直接应用状态
          if (isPlayerReady) {
            applyVideoState({
              currentVideo: message.data
            });
          } else {
            // 如果播放器还没准备好，存储状态等待ready事件
            pendingVideoState = {
              currentVideo: message.data
            };
          }
        }
      }
      break;
      
    case 'play':
      if (isPlayerReady) {
        ignorePlayPause = true;
        // 添加网络延迟补偿
        player.seek = message.data.position + networkDelay / 1000;
        
        // 在移动设备上，尝试强制开始播放
        try {
          const playPromise = player.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => {
              console.warn('自动播放失败:', error);
              addNotification('请点击播放器开始播放');
            });
          }
        } catch (error) {
          console.error('播放错误:', error);
        }
      }
      break;
      
    case 'pause':
      if (isPlayerReady) {
        ignorePlayPause = true;
        player.seek = message.data.position;
        player.pause();
      }
      break;
      
    case 'seek':
      if (isPlayerReady) {
        ignoreSeek = true;
        player.seek = message.data.position;
      }
      break;
      
    case 'changeVideo':
      const videoId = message.data.videoId;
      currentVideoId = videoId;
      
      // 更新UI和播放状态
      const videoItems = videoList.querySelectorAll('.video-item');
      videoItems.forEach(item => {
        if (item.dataset.id === videoId) {
          item.classList.add('active');
          // 使用titleContainer而非整个item获取视频标题
          const titleElement = item.querySelector('.video-title-text');
          videoTitle.textContent = titleElement ? titleElement.textContent : item.dataset.id;
          
          player.url = item.dataset.url;
          
          // 存储状态以待视频加载完成后应用
          pendingVideoState = {
            currentVideo: {
              id: videoId,
              position: message.data.position,
              playing: message.data.playing
            }
          };
        } else {
          item.classList.remove('active');
        }
      });
      break;
      
    case 'notification':
      addNotification(message.data.message);
      userCount.textContent = message.data.users;
      break;
      
    case 'newVideo':
      addVideoToList(message.data.video);
      addNotification(`有新视频添加: ${message.data.video.name}`);
      break;
      
    case 'heartbeat':
      // 计算网络延迟
      const now = Date.now();
      networkDelay = now - lastHeartbeat;
      delayValue.textContent = networkDelay;
      
      // 更新信号指示器样式
      const signalIndicator = document.querySelector('.signal-indicator');
      if (signalIndicator) {
        if (networkDelay <= 100) {
          // 良好信号 (0-100ms) - 显示绿色
          signalIndicator.className = 'signal-indicator signal-good';
        } else if (networkDelay <= 600) {
          // 中等信号 (200-600ms) - 显示黄色
          signalIndicator.className = 'signal-indicator signal-medium';
        } else {
          // 较差信号 (600ms+) - 显示红色
          signalIndicator.className = 'signal-indicator signal-poor';
        }
      }
      break;
      
    case 'stop':
      // 处理所有视频被删除的情况
      currentVideoId = null;
      videoTitle.textContent = '未选择视频';
      if (player) {
        player.url = '';
      }
      addNotification('当前播放的视频已被删除');
      break;
      
    case 'videoDeleted':
      // 处理视频被删除的消息
      const deletedVideoId = message.data.videoId;
      // 从列表中移除视频
      const deletedVideoItem = videoList.querySelector(`li[data-id="${deletedVideoId}"]`);
      if (deletedVideoItem) {
        deletedVideoItem.remove();
      }
      break;
  }
}

// 渲染视频列表
function renderVideoList(videos) {
  videoList.innerHTML = '';
  
  videos.forEach(video => {
    addVideoToList(video);
  });
  
  // 确保当前播放视频被正确标记为active状态
  if (currentVideoId) {
    const currentItem = videoList.querySelector(`li[data-id="${currentVideoId}"]`);
    if (currentItem) {
      currentItem.classList.add('active');
    }
  }
}

// 添加视频到列表
function addVideoToList(video) {
  const li = document.createElement('li');
  li.className = 'video-item';
  
  // 创建视频标题容器
  const titleContainer = document.createElement('span');
  titleContainer.className = 'video-title-text';
  titleContainer.textContent = video.name;
  
  // 创建删除按钮
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-video-btn';
  deleteBtn.innerHTML = '删除';
  deleteBtn.title = '删除此视频';
  
  // 将元素添加到列表项
  li.appendChild(titleContainer);
  li.appendChild(deleteBtn);
  
  // 设置数据属性
  li.dataset.id = video.id;
  li.dataset.url = video.url;
  
  if (currentVideoId === video.id) {
    li.classList.add('active');
  }
  
  // 点击视频标题播放视频
  titleContainer.addEventListener('click', () => {
    playVideo(video.id);
  });
  
  // 点击删除按钮删除视频
  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation(); // 防止触发视频播放
    deleteVideo(video.id);
  });
  
  videoList.appendChild(li);
}

// 删除视频
function deleteVideo(videoId) {
  if (confirm('确定要删除此视频吗？')) {
    fetch(`/api/videos/${videoId}`, {
      method: 'DELETE'
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        // 从列表中移除视频
        const videoItem = videoList.querySelector(`li[data-id="${videoId}"]`);
        if (videoItem) {
          videoItem.remove();
        }
        addNotification('视频已删除');
      } else {
        addNotification('删除视频失败: ' + data.error);
      }
    })
    .catch(error => {
      console.error('删除视频错误:', error);
      addNotification('删除视频失败，请重试');
    });
  }
}

// 播放指定视频
function playVideo(videoId) {
  sendMessage('changeVideo', { 
    videoId, 
    startPosition: 0
  });
}

// 添加通知
function addNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  
  notificationArea.appendChild(notification);
  
  // 保持滚动到最新的通知
  notificationArea.scrollTop = notificationArea.scrollHeight;
  
  // 最多显示20条通知
  const notifications = notificationArea.querySelectorAll('.notification');
  if (notifications.length > 20) {
    notificationArea.removeChild(notifications[0]);
  }
  
  // 同时显示弹窗通知
  showToast(message);
}

// 显示弹窗通知
function showToast(message) {
  const toastContainer = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  
  toastContainer.appendChild(toast);
  
  // 使用setTimeout让DOM有时间更新，然后添加show类
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  // 2秒后开始隐藏动画
  setTimeout(() => {
    toast.classList.add('hide');
    
    // 等待动画完成后移除元素
    setTimeout(() => {
      toast.remove();
    }, 300); // 等待transition完成
  }, 2000);
}

// 发送心跳包
function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    lastHeartbeat = Date.now();
    sendMessage('heartbeat', { timestamp: lastHeartbeat });
  }
}

// 初始化事件监听
function initEventListeners() {
  // 添加视频按钮
  addVideoBtn.addEventListener('click', () => {
    addVideoModal.style.display = 'block';
  });
  
  // 关闭模态窗口按钮
  closeModal.addEventListener('click', () => {
    addVideoModal.style.display = 'none';
  });
  
  // 点击模态窗口外部关闭
  window.addEventListener('click', (event) => {
    if (event.target === addVideoModal) {
      addVideoModal.style.display = 'none';
    }
  });
  
  // 提交添加视频表单
  addVideoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    
    const videoName = document.getElementById('video-name').value.trim();
    const videoUrl = document.getElementById('video-url').value.trim();
    
    if (videoName && videoUrl) {
      fetch('/api/videos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: videoName,
          url: videoUrl
        })
      })
      .then(response => response.json())
      .then(data => {
        console.log('视频添加成功:', data);
        addVideoModal.style.display = 'none';
        
        // 清空表单
        document.getElementById('video-name').value = '';
        document.getElementById('video-url').value = '';
      })
      .catch(error => {
        console.error('添加视频失败:', error);
        addNotification('添加视频失败，请重试');
      });
    }
  });
  
  // 页面关闭前保存播放进度
  window.addEventListener('beforeunload', () => {
    if (player && currentVideoId) {
      sendMessage('userLeave', { position: player.currentTime });
    }
  });
}

// 优化定时更新播放状态的逻辑，确保移动设备也能正常工作
function startStateUpdateInterval() {
  // 如果已经有定时器了，先清除
  if (window.stateUpdateInterval) {
    clearInterval(window.stateUpdateInterval);
  }
  
  // 设置新的定时器
  window.stateUpdateInterval = setInterval(() => {
    if (player && player.isReady) {
      updatePlayerState();
    }
  }, 1000);
  
  // 同时也添加事件监听来触发状态更新
  if (player) {
    // 监听进度变化
    player.on('video:timeupdate', () => {
      // 限制更新频率
      if (!player.timeUpdateThrottle) {
        player.timeUpdateThrottle = setTimeout(() => {
          updatePlayerState();
          player.timeUpdateThrottle = null;
        }, 1000);
      }
    });
  }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init); 