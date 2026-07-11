/**
 * 入退室QRリーダーWebアプリ - Core Logic
 */

// --- 設定定数 ---
const CONFIG = {
  TIMEOUT_DURATION: 15000,       // iframe読み込みタイムアウト(ミリ秒)
  COOLDOWN_DURATION: 5000,       // 同一URLの再受付禁止時間(ミリ秒)
  ALLOWED_PROTOCOLS: ['https:'], // 許可するプロトコル (初期状態は https: のみ)
  ALLOWED_HOSTS: [],             // 許可ドメイン (空配列の場合は全ドメイン許可)
  
  // 状態表示自動復帰のウェイト時間
  SUCCESS_RESET_DELAY: 3000,
  ERROR_RESET_DELAY: 4000,
  DUPLICATE_RESET_DELAY: 3000,
  
  DEBUG: false,                  // デバッグログ出力フラグ
  AUDIO_VOLUME: 0.3              // 完了音・警告音の音量 (0.0 〜 1.0)
};

// --- アプリケーションの状態定義 ---
const STATES = {
  IDLE: 'IDLE',             // 初期状態（カメラ開始待ち）
  SCANNING: 'SCANNING',     // スキャン中
  PROCESSING: 'PROCESSING', // iframe処理中（入退室処理中）
  SUCCESS: 'SUCCESS',       // 処理完了（成功）
  ERROR: 'ERROR',           // エラー発生
  WARNING: 'WARNING'        // 二重読み取り警告等
};

// --- ログ出力制御 ---
function logDebug(...args) {
  if (CONFIG.DEBUG) {
    console.log('[QRReader Debug]', ...args);
  }
}

// --- 状態管理クラス ---
class AppStateMachine {
  constructor(onStateChangeCallback) {
    this.state = STATES.IDLE;
    this.callback = onStateChangeCallback;
  }

  transitionTo(newState, message = '', errorDetail = '') {
    if (!STATES[newState]) {
      logDebug(`Invalid state transition: ${newState}`);
      return;
    }
    logDebug(`State Transition: ${this.state} -> ${newState} (${message})`);
    this.state = newState;
    if (this.callback) {
      this.callback(newState, message, errorDetail);
    }
  }

  getState() {
    return this.state;
  }
}

// --- URL検証ロジック (単体テスト用にエクスポート可能にする) ---
function validateQRCodeURL(text, allowedProtocols = CONFIG.ALLOWED_PROTOCOLS, allowedHosts = CONFIG.ALLOWED_HOSTS) {
  if (!text || text.trim() === '') {
    return { isValid: false, error: 'QRコードの内容が空です。' };
  }

  // JavaScript実行を狙うなどの攻撃コード混入対策
  const lowerText = text.toLowerCase().trim();
  if (lowerText.startsWith('javascript:') || lowerText.startsWith('data:') || lowerText.startsWith('file:')) {
    return { isValid: false, error: '許可されていないプロトコル(javascript/data/file)です。' };
  }

  try {
    const parsedUrl = new URL(text);
    
    // プロトコルチェック
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      return { 
        isValid: false, 
        error: `許可されていないプロトコル (${parsedUrl.protocol}) です。${allowedProtocols.join(', ')} のみ許可されています。` 
      };
    }

    // ドメイン制限チェック
    if (allowedHosts && allowedHosts.length > 0) {
      if (!allowedHosts.includes(parsedUrl.hostname)) {
        return { 
          isValid: false, 
          error: `許可されていない接続先ドメイン (${parsedUrl.hostname}) です。` 
        };
      }
    }

    return { isValid: true, url: parsedUrl };
  } catch (e) {
    return { isValid: false, error: '読み取ったデータは正しいURL形式ではありません。' };
  }
}

// --- Web Audio API 音声合成 ---
class SoundGenerator {
  constructor() {
    this.audioCtx = null;
  }

  init() {
    if (!this.audioCtx) {
      // iOS Safari等での互換性を保つために webkitAudioContext もサポート
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
        logDebug('AudioContext initialized.');
      } else {
        console.error('Web Audio API is not supported in this browser.');
      }
    }
    // iOS Safariではサスペンド状態で開始することがあるため再開させる
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
      logDebug('AudioCtx resumed.');
    }
  }

  playSuccess() {
    this.init();
    if (!this.audioCtx) return;
    
    const now = this.audioCtx.currentTime;
    
    // メインゲインノード (全体の音量制御)
    const mainGain = this.audioCtx.createGain();
    mainGain.gain.setValueAtTime(CONFIG.AUDIO_VOLUME, now);
    mainGain.connect(this.audioCtx.destination);

    // 明るい成功チャイム音 (2音: C6のあとE6を重ねる)
    // 音1: C6 (1046.50 Hz)
    const osc1 = this.audioCtx.createOscillator();
    const gain1 = this.audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1046.50, now);
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(0.6, now + 0.05);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    
    osc1.connect(gain1);
    gain1.connect(mainGain);
    
    // 音2: E6 (1318.51 Hz) - 少し遅れて開始
    const osc2 = this.audioCtx.createOscillator();
    const gain2 = this.audioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1318.51, now + 0.08);
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.setValueAtTime(0, now + 0.08);
    gain2.gain.linearRampToValueAtTime(0.6, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc2.connect(gain2);
    gain2.connect(mainGain);

    osc1.start(now);
    osc1.stop(now + 0.3);
    osc2.start(now);
    osc2.stop(now + 0.55);
    
    logDebug('Played success sound.');
  }

  playError() {
    this.init();
    if (!this.audioCtx) return;

    const now = this.audioCtx.currentTime;
    
    const mainGain = this.audioCtx.createGain();
    mainGain.gain.setValueAtTime(CONFIG.AUDIO_VOLUME, now);
    mainGain.connect(this.audioCtx.destination);

    // 低く濁ったエラー警告音 (鋸歯状波 + 周波数下降)
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.linearRampToValueAtTime(100, now + 0.35); // ピッチを下げる
    
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.8, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.connect(gain);
    gain.connect(mainGain);

    osc.start(now);
    osc.stop(now + 0.45);
    
    logDebug('Played error sound.');
  }

  playWarning() {
    this.init();
    if (!this.audioCtx) return;

    const now = this.audioCtx.currentTime;
    
    const mainGain = this.audioCtx.createGain();
    mainGain.gain.setValueAtTime(CONFIG.AUDIO_VOLUME * 0.8, now);
    mainGain.connect(this.audioCtx.destination);

    // 短い二重スキャン警告音 (矩形波で短くプップッと2回鳴らす)
    const playBeep = (time, duration) => {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(330, time);
      
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.7, time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

      osc.connect(gain);
      gain.connect(mainGain);
      osc.start(time);
      osc.stop(time + duration + 0.05);
    };

    playBeep(now, 0.08);
    playBeep(now + 0.12, 0.08);
    
    logDebug('Played warning sound.');
  }
}

// --- アプリケーションのメインUI制御 ---
class QRReaderApp {
  constructor() {
    this.stateMachine = new AppStateMachine(this.onStateChange.bind(this));
    this.sound = new SoundGenerator();
    
    // スキャン管理用変数
    this.lastScannedUrl = '';
    this.lastScanTime = 0;
    this.stream = null;
    this.scanAnimationId = null;
    
    // iframeのタイムアウトID
    this.iframeTimeoutId = null;

    // DOM要素参照
    this.elements = {};
  }

  // DOM構築後の初期化
  initDOM() {
    this.elements = {
      video: document.getElementById('camera-video'),
      canvas: document.getElementById('qr-canvas'),
      stateMessage: document.getElementById('state-message'),
      statePanel: document.getElementById('state-panel'),
      btnStart: document.getElementById('btn-start'),
      btnReset: document.getElementById('btn-reset'),
      errorPanel: document.getElementById('error-panel'),
      errorText: document.getElementById('error-text'),
      iframe: document.getElementById('process-iframe'),
      overlay: document.querySelector('.scanner-overlay'),
      placeholder: document.querySelector('.camera-placeholder')
    };

    // イベントリスナー設定
    if (this.elements.btnStart) {
      this.elements.btnStart.addEventListener('click', () => this.startCamera());
    }
    if (this.elements.btnReset) {
      this.elements.btnReset.addEventListener('click', () => this.resetToScanning());
    }

    // iframe loadイベントの設定
    if (this.elements.iframe) {
      this.elements.iframe.addEventListener('load', () => this.onIframeLoaded());
    }

    // 初期表示設定
    this.updateThemeColor(STATES.IDLE);
  }

  // 状態変更時の表示制御
  onStateChange(state, message, errorDetail = '') {
    // テーマカラーを更新
    this.updateThemeColor(state);

    // メッセージ更新
    if (this.elements.stateMessage) {
      this.elements.stateMessage.textContent = message || this.getDefaultMessage(state);
    }

    // ボタンの状態制御
    if (this.elements.btnStart) {
      if (state === STATES.IDLE) {
        this.elements.btnStart.classList.remove('disabled');
        this.elements.btnStart.removeAttribute('disabled');
      } else {
        this.elements.btnStart.classList.add('disabled');
        this.elements.btnStart.setAttribute('disabled', 'true');
      }
    }

    // スキャンインジケーター（オーバーレイ）の表示制御
    if (this.elements.overlay) {
      if (state === STATES.SCANNING) {
        this.elements.overlay.classList.add('active');
      } else {
        this.elements.overlay.classList.remove('active');
      }
    }

    // エラー詳細表示制御
    if (this.elements.errorPanel && this.elements.errorText) {
      if (state === STATES.ERROR && errorDetail) {
        this.elements.errorText.textContent = errorDetail;
        this.elements.errorPanel.classList.add('visible');
      } else if (state !== STATES.ERROR) {
        // エラー状態から抜ける時はエラーログをクリアしないが、非表示にする
        this.elements.errorPanel.classList.remove('visible');
      }
    }

    // プレースホルダー表示制御
    if (this.elements.placeholder) {
      if (state === STATES.IDLE) {
        this.elements.placeholder.style.opacity = '1';
        this.elements.placeholder.style.pointerEvents = 'auto';
      } else {
        this.elements.placeholder.style.opacity = '0';
        this.elements.placeholder.style.pointerEvents = 'none';
      }
    }
  }

  getDefaultMessage(state) {
    switch (state) {
      case STATES.IDLE: return 'カメラを開始してください';
      case STATES.SCANNING: return 'QRコードをかざしてください';
      case STATES.PROCESSING: return '入退室処理中です...';
      case STATES.SUCCESS: return '処理が完了しました';
      case STATES.ERROR: return 'エラーが発生しました';
      case STATES.WARNING: return '警告';
      default: return '';
    }
  }

  updateThemeColor(state) {
    let colorVar = '--color-idle';
    let glow = 'rgba(100, 116, 139, 0.15)';
    
    switch (state) {
      case STATES.IDLE:
        colorVar = '--color-idle';
        glow = 'rgba(100, 116, 139, 0.15)';
        break;
      case STATES.SCANNING:
        colorVar = '--color-scanning';
        glow = 'rgba(59, 130, 246, 0.15)';
        break;
      case STATES.PROCESSING:
        colorVar = '--color-processing';
        glow = 'rgba(245, 158, 11, 0.15)';
        break;
      case STATES.SUCCESS:
        colorVar = '--color-success';
        glow = 'rgba(16, 185, 129, 0.2)';
        break;
      case STATES.ERROR:
        colorVar = '--color-error';
        glow = 'rgba(239, 68, 68, 0.2)';
        break;
      case STATES.WARNING:
        colorVar = '--color-warning';
        glow = 'rgba(236, 72, 153, 0.2)';
        break;
    }

    const root = document.documentElement;
    const colorVal = getComputedStyle(root).getPropertyValue(colorVar).trim();
    root.style.setProperty('--theme-color', colorVal);
    root.style.setProperty('--theme-color-glow', glow);
  }

  // カメラ起動処理
  async startCamera() {
    if (this.stateMachine.getState() !== STATES.IDLE) {
      return;
    }

    // 初回タップ時にAudioContextをアクティベート
    this.sound.init();

    logDebug('Starting camera...');
    
    // カメラの制約設定 (インカメラ/フロントカメラ優先)
    const constraints = {
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (this.elements.video) {
        this.elements.video.srcObject = this.stream;
        // iOS Safariで自動再生させるために必要な属性を設定
        this.elements.video.setAttribute('playsinline', 'true');
        this.elements.video.setAttribute('autoplay', 'true');
        this.elements.video.setAttribute('muted', 'true');
        
        // 動画の再生開始を待つ
        await this.elements.video.play();
      }

      this.stateMachine.transitionTo(STATES.SCANNING, 'QRコードをかざしてください');
      
      // スキャンループ開始
      this.startScanLoop();

    } catch (error) {
      console.error('Camera startup error:', error);
      let errorMsg = 'カメラの起動に失敗しました。';
      let detail = error.message || error.name || '';
      
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        errorMsg = 'カメラへのアクセスが拒否されました。設定アプリからSafariのカメラ権限を「許可」にしてください。';
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        errorMsg = '利用可能なカメラが見つかりません。';
      } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        errorMsg = 'カメラの使用にはHTTPS(暗号化通信)接続が必要です。アドレスが https:// で始まっているか確認してください。';
      }

      this.sound.playError();
      this.stateMachine.transitionTo(STATES.ERROR, 'カメラを起動できません', `${errorMsg} (${detail})`);
    }
  }

  // スキャンループ (RequestAnimationFrame)
  startScanLoop() {
    const scan = () => {
      if (this.stateMachine.getState() !== STATES.SCANNING) {
        // スキャン中でなければループを継続しない
        this.scanAnimationId = requestAnimationFrame(scan);
        return;
      }

      const video = this.elements.video;
      const canvas = this.elements.canvas;

      // ビデオストリームが有効で、準備ができているか確認
      if (video && video.readyState === video.HAVE_ENOUGH_DATA && canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        // 解析用のキャンバスサイズをビデオに合わせる
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // キャンバスへ描画
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // 画像データを取得
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // jsQRで解析を実行
        // グローバル変数 jsQR は jsQR.js を読み込むことで定義されている
        if (typeof jsQR !== 'undefined') {
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });

          if (code) {
            logDebug('QR Code detected:', code.data);
            this.handleQRCodeDetected(code.data);
          }
        } else {
          console.error('jsQR library is not loaded.');
          this.sound.playError();
          this.stateMachine.transitionTo(STATES.ERROR, 'エラーが発生しました', 'QRコード解析ライブラリ(jsQR.js)が読み込まれていません。リロードしてください。');
          this.stopCamera();
          return;
        }
      }

      this.scanAnimationId = requestAnimationFrame(scan);
    };

    this.scanAnimationId = requestAnimationFrame(scan);
  }

  // QRコード検出時の処理フロー
  handleQRCodeDetected(text) {
    // 1. URLとして正しい形式か検証
    const validation = validateQRCodeURL(text);
    
    if (!validation.isValid) {
      // 不正なQRコードの場合
      logDebug('Invalid URL scanned:', text, validation.error);
      this.sound.playError();
      this.stateMachine.transitionTo(STATES.ERROR, '読み取りエラー', `無効なQRコードです: ${validation.error}`);
      
      // エラー表示後、数秒待ってから自動でスキャン再開
      this.autoResetToScanning(CONFIG.ERROR_RESET_DELAY);
      return;
    }

    const targetUrl = validation.url.href;

    // 2. 二重読み取り防止の検証 (同一URLの短時間での連続スキャン抑止)
    const now = Date.now();
    if (targetUrl === this.lastScannedUrl && (now - this.lastScanTime) < CONFIG.COOLDOWN_DURATION) {
      logDebug('Duplicate scan blocked:', targetUrl);
      this.sound.playWarning();
      this.stateMachine.transitionTo(STATES.WARNING, '同じQRコードが連続して読み取られました');
      
      // 警告表示後、自動でスキャンを再開
      this.autoResetToScanning(CONFIG.DUPLICATE_RESET_DELAY);
      return;
    }

    // 有効な新しいスキャンとして受け付け
    this.lastScannedUrl = targetUrl;
    this.lastScanTime = now;

    // 3. 処理開始 (一時的に新しいスキャンを抑止)
    this.stateMachine.transitionTo(STATES.PROCESSING, '入退室処理中です');

    // 4. 非表示iframeへURLを設定してロード開始
    this.loadIframe(targetUrl);
  }

  // 非表示のiframeへアクセス
  loadIframe(url) {
    if (!this.elements.iframe) {
      this.sound.playError();
      this.stateMachine.transitionTo(STATES.ERROR, 'システムエラー', '処理用インフラ(iframe)が見つかりません。');
      this.autoResetToScanning(CONFIG.ERROR_RESET_DELAY);
      return;
    }

    // 以前のタイムアウトがあればクリア
    if (this.iframeTimeoutId) {
      clearTimeout(this.iframeTimeoutId);
    }

    // タイムアウト監視を開始
    this.iframeTimeoutId = setTimeout(() => {
      logDebug('Iframe loading timeout:', url);
      this.clearIframe();
      this.sound.playError();
      this.stateMachine.transitionTo(STATES.ERROR, '通信タイムアウト', `本部サーバーの応答がありませんでした(制限時間: ${CONFIG.TIMEOUT_DURATION / 1000}秒)`);
      this.autoResetToScanning(CONFIG.ERROR_RESET_DELAY);
    }, CONFIG.TIMEOUT_DURATION);

    // URLをiframeへ設定してロード開始
    logDebug('Loading URL in hidden iframe:', url);
    this.elements.iframe.src = url;
  }

  // iframe読み込み完了ハンドラ
  onIframeLoaded() {
    // PROCESSING状態の時のみ成功処理を行う (初期の about:blank 読み込みや、タイムアウト後の遅延ロードを除外するため)
    if (this.stateMachine.getState() !== STATES.PROCESSING) {
      return;
    }

    logDebug('Iframe loaded successfully.');

    // タイムアウト監視をクリア
    if (this.iframeTimeoutId) {
      clearTimeout(this.iframeTimeoutId);
      this.iframeTimeoutId = null;
    }

    // 1. 完了音を鳴らす
    this.sound.playSuccess();

    // 2. 成功状態へ遷移
    this.stateMachine.transitionTo(STATES.SUCCESS, '処理が完了しました');

    // 3. iframeを初期化
    this.clearIframe();

    // 4. スキャナーの自動再開
    this.autoResetToScanning(CONFIG.SUCCESS_RESET_DELAY);
  }

  // iframeの初期化 (二重読み込みや余計なイベント発生防止)
  clearIframe() {
    if (this.elements.iframe) {
      // イベントをトリガーしないよう src を初期値に戻す
      this.elements.iframe.src = 'about:blank';
    }
  }

  // 一定時間経過後にスキャナーを自動再開するタイマー
  autoResetToScanning(delayMs) {
    if (this.autoResetTimeoutId) {
      clearTimeout(this.autoResetTimeoutId);
    }
    this.autoResetTimeoutId = setTimeout(() => {
      this.resetToScanning();
    }, delayMs);
  }

  // スキャン状態への手動・自動復帰
  resetToScanning() {
    if (this.autoResetTimeoutId) {
      clearTimeout(this.autoResetTimeoutId);
      this.autoResetTimeoutId = null;
    }
    
    const currentState = this.stateMachine.getState();
    
    // スキャン中でない、かつIDLEでもない場合にスキャン再開
    if (currentState !== STATES.SCANNING && currentState !== STATES.IDLE) {
      this.stateMachine.transitionTo(STATES.SCANNING, 'QRコードをかざしてください');
    }
  }

  // カメラの完全停止 (アンロード用)
  stopCamera() {
    logDebug('Stopping camera...');
    if (this.scanAnimationId) {
      cancelAnimationFrame(this.scanAnimationId);
      this.scanAnimationId = null;
    }
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.elements.video) {
      this.elements.video.srcObject = null;
    }

    this.stateMachine.transitionTo(STATES.IDLE, 'カメラを開始してください');
  }
}

// Global Export for testing and app startup
window.QRReader = {
  CONFIG,
  STATES,
  validateQRCodeURL,
  AppStateMachine,
  SoundGenerator,
  QRReaderApp,
  app: null
};

// ページロード時にアプリケーションの初期化を開始
window.addEventListener('DOMContentLoaded', () => {
  // テスト用（iframeやvideo要素がない環境）での起動を防ぐため、存在確認
  if (document.getElementById('camera-video')) {
    window.QRReader.app = new QRReaderApp();
    window.QRReader.app.initDOM();
  }
});
