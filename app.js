// ========================================
// ケアプラン作成支援アプリ - メインアプリケーション
// ========================================

// グローバル状態
let currentScreen = 'homeScreen';
let selectedServiceType = null;
let currentCategoryIndex = 0;
let assessmentData = {};
let basicInfoData = {};
let carePlanItems = [];
let useLocalAI = false;
let aiSession = null;
let apiKey = localStorage.getItem('geminiApiKey') || '';

// 利用者管理
let users = JSON.parse(localStorage.getItem('careplan_users') || '[]');
let currentUserId = null;
let currentPlanId = null; // 現在編集中の計画書ID
let savedCarePlans = JSON.parse(localStorage.getItem('careplan_plans') || '[]');

// ========================================
// 初期化
// ========================================
document.addEventListener('DOMContentLoaded', async () => {
    // Service Worker登録（オフライン対応）
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('./service-worker.js');
            console.log('Service Worker登録成功');
        } catch (error) {
            console.log('Service Worker登録失敗:', error);
        }
    }

    await checkLocalAI();
    showScreen('homeScreen');
});

// ========================================
// ローカルAIチェック
// ========================================
async function checkLocalAI() {
    try {
        if ('ai' in window && 'languageModel' in window.ai) {
            const capabilities = await window.ai.languageModel.capabilities();

            if (capabilities.available === 'readily') {
                aiSession = await window.ai.languageModel.create();
                useLocalAI = true;
                updatePrivacyBadge(true);
                updateAIStatusBadge(true);
                console.log('ローカルAI利用可能');
            } else if (capabilities.available === 'after-download') {
                updatePrivacyBadge(false, 'AIモデルをダウンロード中...');
                aiSession = await window.ai.languageModel.create();
                useLocalAI = true;
                updatePrivacyBadge(true);
                updateAIStatusBadge(true);
            } else {
                throw new Error('ローカルAI非対応');
            }
        } else {
            throw new Error('Prompt API未対応');
        }
    } catch (error) {
        console.log('ローカルAI利用不可:', error);
        useLocalAI = false;
        updatePrivacyBadge(false);
        updateAIStatusBadge(false);
        showFallbackNotice();
    }
}

function updateAIStatusBadge(isLocal) {
    const badge = document.getElementById('aiStatusBadge');
    if (!badge) return;

    if (isLocal) {
        badge.innerHTML = `
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 12px 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 4px;">✅</div>
                <div style="font-weight: 600;">ローカルAI利用可能</div>
                <div style="font-size: 12px; opacity: 0.9;">完全オフラインで動作します</div>
            </div>
        `;
    } else {
        badge.innerHTML = `
            <div style="background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); color: white; padding: 12px 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 4px;">⚠️</div>
                <div style="font-weight: 600;">ローカルAI利用不可</div>
                <div style="font-size: 12px; opacity: 0.9;">${apiKey ? 'APIキー設定済み' : '手動入力または設定からAPIキーを入力'}</div>
            </div>
        `;
    }
}

function showFallbackNotice() {
    const notice = document.getElementById('fallbackNotice');
    if (notice) {
        notice.classList.remove('hidden');
    }
}

function updatePrivacyBadge(isLocal, customMessage = null) {
    const badge = document.getElementById('privacyBadge');
    if (!badge) return;

    if (customMessage) {
        badge.innerHTML = `⏳ ${customMessage}`;
        badge.className = 'privacy-badge processing';
    } else if (isLocal) {
        badge.innerHTML = '🔒 端末内処理のみ - データは外部送信されません';
        badge.className = 'privacy-badge';
    } else {
        badge.innerHTML = '🔐 データはあなたの端末に保存されます';
        badge.className = 'privacy-badge';
    }
}

// ========================================
// 画面遷移
// ========================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.add('active');
        currentScreen = screenId;
    }

    // 画面ごとの初期化
    if (screenId === 'assessmentScreen') {
        renderCategoryTabs();
        renderCategoryContent();
    } else if (screenId === 'carePlanScreen') {
        renderCarePlan();
    }
}

// ========================================
// サービス種別選択
// ========================================
function selectServiceType(type) {
    selectedServiceType = type;

    // UI更新
    document.querySelectorAll('.service-type-card').forEach(card => {
        card.classList.remove('selected');
    });
    document.querySelector(`[data-type="${type}"]`)?.classList.add('selected');

    // 次へボタン有効化
    const nextBtn = document.getElementById('startAssessmentBtn');
    if (nextBtn) nextBtn.disabled = false;
}

function startAssessment() {
    if (!selectedServiceType) {
        alert('サービス種別を選択してください');
        return;
    }
    currentPlanId = null; // 新規作成なのでリセット
    carePlanItems = []; // 計画書アイテムもリセット
    assessmentData = {}; // アセスメントデータもリセット
    currentCategoryIndex = 0; // カテゴリインデックスもリセット

    // 匿名保存データがあるか確認（利用者未選択の場合）
    let loadedFromProgress = false;
    if (!currentUserId) {
        const savedProgress = localStorage.getItem('assessment_progress_anonymous');
        if (savedProgress) {
            try {
                const data = JSON.parse(savedProgress);
                const savedDate = new Date(data.savedAt).toLocaleString('ja-JP');
                if (confirm(`途中保存データがあります（${savedDate}）\n続きから再開しますか？`)) {
                    assessmentData = data.assessmentData || {};
                    selectedServiceType = data.selectedServiceType || selectedServiceType;
                    currentCategoryIndex = data.currentCategoryIndex || 0;
                    loadedFromProgress = true;
                }
            } catch (e) {
                console.error('途中保存データの読み込みエラー:', e);
            }
        }
    }

    showScreen('assessmentScreen');
    updateCurrentUserBanner();

    // 途中保存から読み込んだ場合は、カテゴリUIを再レンダリング
    if (loadedFromProgress) {
        renderCategoryTabs();
        renderCategoryContent();
    }
}

// 利用者バナーを更新
function updateCurrentUserBanner() {
    const banner = document.getElementById('currentUserBanner');
    const nameElement = document.getElementById('currentUserName');

    if (!banner || !nameElement) return;

    if (currentUserId) {
        const user = users.find(u => u.id === currentUserId);
        if (user) {
            nameElement.textContent = user.initial;
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    } else {
        banner.style.display = 'none';
    }
}

// アセスメント途中保存
function saveAssessmentProgress() {
    saveCurrentCategoryData();

    // 保存するデータ
    const progressData = {
        assessmentData: { ...assessmentData },
        selectedServiceType: selectedServiceType,
        currentCategoryIndex: currentCategoryIndex,
        savedAt: new Date().toISOString()
    };

    // 利用者IDがある場合はそのIDで、ない場合は「匿名」で保存
    const saveKey = currentUserId ? `assessment_progress_${currentUserId}` : 'assessment_progress_anonymous';
    localStorage.setItem(saveKey, JSON.stringify(progressData));

    showToast('アセスメントを途中保存しました');
}

// アセスメント途中データを読み込む
function loadAssessmentProgress(userId) {
    const progressKey = `assessment_progress_${userId}`;
    const savedProgress = localStorage.getItem(progressKey);

    if (savedProgress) {
        try {
            const data = JSON.parse(savedProgress);
            const savedDate = new Date(data.savedAt).toLocaleString('ja-JP');

            if (confirm(`途中保存データがあります（${savedDate}）\n続きから再開しますか？`)) {
                assessmentData = data.assessmentData || {};
                selectedServiceType = data.selectedServiceType;
                currentCategoryIndex = data.currentCategoryIndex || 0;
                return true;
            }
        } catch (e) {
            console.error('途中保存データの読み込みエラー:', e);
        }
    }
    return false;
}

// 途中保存データを削除
function clearAssessmentProgress(userId) {
    const progressKey = `assessment_progress_${userId}`;
    localStorage.removeItem(progressKey);
}

// アセスメント画面から離れる前の確認
function confirmLeaveAssessment() {
    saveCurrentCategoryData();

    // データがあるか確認
    const hasData = Object.values(assessmentData).some(data =>
        data.checkedItems && data.checkedItems.length > 0
    );

    if (hasData) {
        if (confirm('入力中のデータがあります。途中保存しますか？')) {
            saveAssessmentProgress();
        }
    }

    showScreen('homeScreen');
}

// ========================================
// カテゴリタブ
// ========================================
function renderCategoryTabs() {
    const container = document.getElementById('categoryTabs');
    if (!container) return;

    const html = ASSESSMENT_CATEGORIES.map((cat, index) => {
        const isActive = index === currentCategoryIndex;
        const data = assessmentData[cat.id] || { checkedItems: [] };
        const hasData = data.checkedItems.length > 0;

        return `
            <button class="category-tab ${isActive ? 'active' : ''}" 
                    onclick="switchCategory(${index})">
                <span>${cat.icon}</span>
                <span>${cat.name}</span>
                ${hasData ? `<span class="badge">${data.checkedItems.length}</span>` : ''}
            </button>
        `;
    }).join('');

    container.innerHTML = html;
}

function switchCategory(index) {
    saveCurrentCategoryData();
    currentCategoryIndex = index;
    renderCategoryTabs();
    renderCategoryContent();
}

// ========================================
// カテゴリコンテンツ
// ========================================
function renderCategoryContent() {
    const container = document.getElementById('categoryContent');
    if (!container) return;

    const category = ASSESSMENT_CATEGORIES[currentCategoryIndex];
    const savedData = assessmentData[category.id] || { checkedItems: [], detailText: '' };

    const html = `
        <div class="card">
            <h3 class="card-title">
                <span class="icon">${category.icon}</span>
                ${category.name}
            </h3>
            
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
                該当する項目にチェックを入れてください
            </p>
            
            <div class="checkbox-list">
                ${category.checkItems.map((item, index) => `
                    <div class="checkbox-item">
                        <input type="checkbox" 
                               id="check-${index}" 
                               ${savedData.checkedItems.includes(item) ? 'checked' : ''}
                               onchange="onCheckChange()">
                        <label for="check-${index}">${item}</label>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="card">
            <h3 class="card-title">具体的内容・対応するケア項目</h3>
            <textarea class="form-textarea" 
                      id="detailText" 
                      placeholder="チェックした項目について、詳細を記入してください"
                      onblur="saveCurrentCategoryData()">${savedData.detailText || ''}</textarea>
        </div>
        
        <div class="card">
            <button class="generate-btn ${useLocalAI ? 'local-ai' : ''}" 
                    onclick="generateFromCategory()" 
                    id="generateCategoryBtn"
                    ${!useLocalAI && !apiKey ? 'disabled' : ''}>
                ${useLocalAI ? '🔒 この項目を生成（端末内処理）' : '✨ この項目を生成'}
            </button>
            
            <button class="btn btn-success btn-block mt-4" 
                    onclick="showIntegratedGenerationModal()">
                🔄 すべてから統合生成（7カテゴリ）
                <span id="checkedCount">(${getCheckedCategoryCount()}項目)</span>
            </button>
            
            <button class="btn btn-secondary btn-block mt-4" 
                    onclick="showSuggestions()">
                ✨ この項目から提案を表示（API不要）
            </button>
            
            ${!useLocalAI && !apiKey ? `
                <p style="color: var(--warning-color); font-size: 13px; margin-top: 12px; text-align: center;">
                    ⚠️ AI機能を使うには<a href="#" onclick="openSettings(); return false;">設定</a>からAPIキーを入力してください
                </p>
            ` : ''}
        </div>
    `;

    container.innerHTML = html;
}

function onCheckChange() {
    saveCurrentCategoryData();
    renderCategoryTabs();
    document.getElementById('checkedCount').textContent = `(${getCheckedCategoryCount()}項目)`;
}

function saveCurrentCategoryData() {
    const category = ASSESSMENT_CATEGORIES[currentCategoryIndex];
    const checkedItems = [];

    category.checkItems.forEach((item, index) => {
        const checkbox = document.getElementById(`check-${index}`);
        if (checkbox && checkbox.checked) {
            checkedItems.push(item);
        }
    });

    const detailText = document.getElementById('detailText')?.value || '';

    assessmentData[category.id] = {
        checkedItems,
        detailText
    };
}

function getCheckedCategoryCount() {
    let count = 0;
    ASSESSMENT_CATEGORIES.forEach(cat => {
        const data = assessmentData[cat.id];
        if (data && data.checkedItems && data.checkedItems.length > 0) {
            count++;
        }
    });
    return count;
}

// ========================================
// AI生成
// ========================================
async function generateFromCategory() {
    saveCurrentCategoryData();

    const category = ASSESSMENT_CATEGORIES[currentCategoryIndex];
    const data = assessmentData[category.id];

    if (!data || data.checkedItems.length === 0) {
        alert('少なくとも1つの項目にチェックを入れてください');
        return;
    }

    showLoading(true);

    try {
        const result = await callAI(buildCategoryPrompt(category, data));

        carePlanItems.push({
            categoryName: category.name,
            ...result
        });

        showScreen('carePlanScreen');
    } catch (error) {
        showErrorModal(error.message);
    } finally {
        showLoading(false);
    }
}

async function generateFromAllCategories() {
    saveCurrentCategoryData();

    const checkedCategories = [];
    ASSESSMENT_CATEGORIES.forEach(cat => {
        const data = assessmentData[cat.id];
        if (data && data.checkedItems && data.checkedItems.length > 0) {
            checkedCategories.push({
                ...cat,
                data
            });
        }
    });

    if (checkedCategories.length === 0) {
        alert('少なくとも1つのカテゴリでチェックを入れてください');
        return;
    }

    showLoading(true);

    try {
        const results = await callAI(buildIntegratedPrompt(checkedCategories));

        if (Array.isArray(results)) {
            results.forEach(item => carePlanItems.push(item));
        }

        showScreen('carePlanScreen');
    } catch (error) {
        showErrorModal(error.message);
    } finally {
        showLoading(false);
    }
}

// ========================================
// AI呼び出し
// ========================================
async function callAI(prompt, parseJson = true) {
    console.log('プロンプト:', prompt);

    let responseText;

    if (useLocalAI && aiSession) {
        // ローカルAI
        updatePrivacyBadge(true, '端末内でAI処理中...');
        responseText = await aiSession.prompt(prompt);
        updatePrivacyBadge(true);
    } else if (apiKey) {
        // API（フォールバック）
        responseText = await callGeminiAPI(prompt);
    } else {
        throw new Error('AIが利用できません。設定からAPIキーを入力してください。');
    }

    console.log('AIレスポンス:', responseText);

    // JSON解析が不要な場合はテキストをそのまま返す
    if (!parseJson) {
        return responseText;
    }

    return parseAIResponse(responseText);
}

async function callGeminiAPI(prompt) {
    // 利用可能なモデル（2026年現在）
    const modelName = 'gemini-2.5-flash';

    console.log('Gemini API呼び出し開始');
    console.log('APIキー:', apiKey ? apiKey.substring(0, 10) + '...' : 'なし');

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 8192
                }
            })
        });

        console.log('APIレスポンスステータス:', response.status);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('APIエラー詳細:', errorData);
            const errorMessage = errorData?.error?.message || `HTTPエラー ${response.status}`;
            throw new Error(translateApiError(errorMessage));
        }

        const data = await response.json();
        console.log("APIレスポンス全体:", JSON.stringify(data));

        // テキストを安全に抽出
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (!text) {
            console.error('APIレスポンスからテキストを抽出できませんでした。完全なデータ:', JSON.stringify(data));
        }

        return text;
    } catch (error) {
        console.error('Gemini API呼び出しエラー:', error);
        throw error;
    }
}

// APIエラーを日本語に変換
function translateApiError(errorMessage) {
    // 無料枠制限エラー
    if (errorMessage.includes('exceeded your current quota') ||
        errorMessage.includes('Quota exceeded') ||
        errorMessage.includes('rate limit')) {
        return `⚠️ Gemini API の無料枠制限に達しました。

【解決方法】
• しばらく待ってから再試行してください（1〜2分）
• 「✨ 提案を表示（API不要）」ボタンを使えば、APIを使わずにテンプレートから自動的にケアプランを生成できます！

💡 API不要モードなら制限を気にせず使えます。`;
    }

    // APIキーエラー
    if (errorMessage.includes('API_KEY_INVALID') ||
        errorMessage.includes('API key not valid')) {
        return `⚠️ APIキーが無効です。

【解決方法】
• 設定画面でAPIキーを確認してください
• Google AI StudioでAPIキーを再発行してください
• 「✨ 提案を表示（API不要）」ボタンなら、APIキーなしで使えます！`;
    }

    // モデルアクセスエラー
    if (errorMessage.includes('model not found') ||
        errorMessage.includes('permission denied')) {
        return `⚠️ AIモデルにアクセスできません。

【解決方法】
• 「✨ 提案を表示（API不要）」ボタンをお試しください
• APIキーなしでテンプレートから生成できます！`;
    }

    // その他のエラー
    return `⚠️ AI生成でエラーが発生しました。

${errorMessage}

【代替方法】
「✨ 提案を表示（API不要）」ボタンを使えば、APIを使わずにケアプランを生成できます！`;
}

function parseAIResponse(text) {
    try {
        const cleanedText = text
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();

        // 配列を探す
        const arrayMatch = cleanedText.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            return JSON.parse(arrayMatch[0]);
        }

        // オブジェクトを探す
        const objectMatch = cleanedText.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            return JSON.parse(objectMatch[0]);
        }

        throw new Error('JSONが見つかりません');
    } catch (error) {
        console.error('パースエラー:', error);
        return {
            needs: '課題の把握が必要である',
            longTermGoal: '適切なケアを受けて安心して生活できる',
            shortTermGoal: '日常生活の課題を改善できる',
            serviceContent: '個別のケアプランに基づくサービス提供'
        };
    }
}

// ========================================
// プロンプト構築
// ========================================
function buildCategoryPrompt(category, data) {
    const serviceTypeName = SERVICE_TYPES[selectedServiceType]?.planName || 'サービス計画書（第2表）';

    return `あなたは介護支援専門員（ケアマネジャー）です。以下の情報から${serviceTypeName}を作成してください。

【カテゴリ】${category.name}
【課題項目】${data.checkedItems.join('、')}
${data.detailText ? `【具体的内容】${data.detailText}` : ''}

【記述ルール】
- ニーズは「〜〜だが、〜〜したい」という形式で1文にまとめる
- 長期目標は55文字以内で「〜〜できる」で終わる
- 短期目標は55文字以内で「〜〜できる」で終わる

以下のJSON形式で出力してください：
{
  "needs": "ニーズ（〜〜だが、〜〜したい）",
  "longTermGoal": "長期目標（55文字以内、〜〜できる）",
  "shortTermGoal": "短期目標（55文字以内、〜〜できる）",
  "serviceContent": "サービス内容"
}`;
}

// プロンプト圧縮: 特記事項がある項目のみ抽出
function compressAssessmentData(categories) {
    return categories
        .filter(cat => cat.data.checkedItems.length > 0 || cat.data.detailText)
        .map(cat => ({
            category: cat.name,
            issues: cat.data.checkedItems,
            detail: cat.data.detailText
        }));
}

function buildIntegratedPrompt(categories) {
    const serviceTypeName = SERVICE_TYPES[selectedServiceType]?.planName || 'サービス計画書（第2表）';

    // 圧縮されたカテゴリ情報（トークン削減）
    const compressed = compressAssessmentData(categories);
    const categoryInfo = compressed.map((item, i) => {
        let info = `${i + 1}. ${item.category}`;
        if (item.issues.length > 0) {
            info += `\n   課題: ${item.issues.join('、')}`;
        }
        if (item.detail) {
            info += `\n   詳細: ${item.detail}`;
        }
        return info;
    }).join('\n');

    // ローカルAI向けに最適化されたプロンプト（短く簡潔に）
    const outputCount = Math.min(compressed.length, 5);

    return `【${serviceTypeName}生成】

${categoryInfo}

【ルール】
- ニーズ: 「〜だが、〜したい」形式
- 長期目標: 55文字以内「〜できる」
- 短期目標: 55文字以内「〜できる」

【出力】JSON配列で${outputCount}件:
[{"categoryName":"名前","needs":"ニーズ","longTermGoal":"長期目標","shortTermGoal":"短期目標","serviceContent":"サービス"}]`;
}

// ========================================
// 計画書表示
// ========================================
function renderCarePlan() {
    const container = document.getElementById('carePlanContent');
    if (!container) return;

    if (carePlanItems.length === 0) {
        container.innerHTML = '<p class="text-center py-4">生成された計画書がありません</p>';
        return;
    }

    // APIキーがなくても編集可能（手動編集はいつでもOK）
    const canEdit = true;

    // セルごとの編集ボタンを生成するヘルパー関数
    const editableCell = (index, field, content) => {
        if (canEdit) {
            return `
                <div style="display: flex; align-items: flex-start; gap: 4px;">
                    <span style="flex: 1;">${content || ''}</span>
                    <button onclick="showFieldEditModal(${index}, '${field}')" 
                            style="background: none; border: none; cursor: pointer; opacity: 0.6; font-size: 12px; padding: 2px;"
                            title="この項目を編集">
                        ✏️
                    </button>
                </div>
            `;
        }
        return content || '';
    };

    const html = `
        <div class="card" style="overflow-x: auto;">
            <table class="careplan-table">
                <thead>
                    <tr>
                        <th style="width: 80px;">カテゴリ</th>
                        <th>ニーズ</th>
                        <th>長期目標</th>
                        <th>短期目標</th>
                        <th>サービス内容</th>
                        <th style="width: 40px;"></th>
                    </tr>
                </thead>
                <tbody>
                    ${carePlanItems.map((item, index) => `
                        <tr>
                            <td>${item.categoryName || ''}</td>
                            <td>${editableCell(index, 'needs', item.needs)}</td>
                            <td>${editableCell(index, 'longTermGoal', item.longTermGoal)}</td>
                            <td>${editableCell(index, 'shortTermGoal', item.shortTermGoal)}</td>
                            <td>${editableCell(index, 'serviceContent', item.serviceContent)}</td>
                            <td style="white-space: nowrap;">
                                <button onclick="deleteCarePlanItem(${index})" 
                                        style="background: none; border: none; cursor: pointer;"
                                        title="削除">
                                    🗑️
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        
        <div class="card">
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                <button class="btn btn-success" onclick="saveCarePlan()">💾 保存</button>
                <button class="btn btn-secondary" onclick="copyToClipboard()">📋 コピー</button>
                <button class="btn btn-secondary" onclick="exportToCSV()">📄 CSV出力</button>
                <button class="btn btn-primary" onclick="showScreen('assessmentScreen')">➕ 追加</button>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

function deleteCarePlanItem(index) {
    if (confirm('この項目を削除しますか？')) {
        carePlanItems.splice(index, 1);
        renderCarePlan();
    }
}

// ========================================
// 編集機能（API使用時のみ）- 個別セル編集
// ========================================
const FIELD_LABELS = {
    needs: 'ニーズ',
    longTermGoal: '長期目標',
    shortTermGoal: '短期目標',
    serviceContent: 'サービス内容'
};

function showFieldEditModal(index, field) {
    const item = carePlanItems[index];
    if (!item) return;

    const fieldLabel = FIELD_LABELS[field] || field;
    const currentValue = item[field] || '';

    const modal = document.createElement('div');
    modal.id = 'fieldEditModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    // ニーズ編集の場合はハイブリッドUIを表示
    if (field === 'needs') {
        // ニーズを「状態」と「希望」に分離
        let state = '';
        let wish = '';
        if (currentValue.includes('だが、')) {
            const parts = currentValue.split('だが、');
            state = parts[0];
            wish = parts[1] || '';
        } else if (currentValue.includes('だが')) {
            const parts = currentValue.split('だが');
            state = parts[0];
            wish = parts[1] || '';
        } else {
            state = currentValue;
            wish = '';
        }

        // カテゴリ名から状態の選択肢を生成
        const categoryName = (item.categoryName || '').replace(/^[^\s]+\s/, '');
        const stateSuggestions = generateStateSuggestions(categoryName, state);

        modal.innerHTML = `
            <div style="
                background: var(--bg-color);
                border-radius: 16px;
                max-width: 500px;
                width: 100%;
                padding: 24px;
                max-height: 90vh;
                overflow-y: auto;
            ">
                <h2 style="margin-bottom: 16px; color: var(--text-color);">✏️ ${fieldLabel}を編集</h2>
                <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
                    「${item.categoryName}」の${fieldLabel}を編集します
                </p>
                
                <!-- ハイブリッドUI：状態の選択 -->
                <div style="margin-bottom: 16px; padding: 16px; background: #1e1e2e; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="color: #a0a0ff; margin-bottom: 10px; font-weight: 700; font-size: 15px;">📝 状態を選択：</div>
                    <select id="needsStateSelect" onchange="updateNeedsEditPreview()" style="
                        width: 100%;
                        padding: 10px;
                        border-radius: 8px;
                        border: 1px solid var(--border-color);
                        background: var(--card-bg);
                        color: var(--text-color);
                        font-size: 15px;
                        margin-bottom: 8px;
                    ">
                        ${stateSuggestions.map((s, i) => `<option value="${s}" ${i === 0 ? 'selected' : ''}>${s}</option>`).join('')}
                        <option value="__custom__">✏️ 自由入力...</option>
                    </select>
                    <input type="text" id="needsCustomState" placeholder="状態を入力" value="${state}" style="
                        display: none;
                        width: 100%;
                        padding: 10px;
                        border-radius: 8px;
                        border: 1px solid var(--border-color);
                        background: var(--card-bg);
                        color: var(--text-color);
                        font-size: 15px;
                    " oninput="updateNeedsEditPreview()">
                </div>
                
                <div style="margin-bottom: 16px;">
                    <label style="color: var(--text-secondary); font-size: 14px;">希望部分（「だが、○○」の○○）：</label>
                    <input type="text" id="needsWish" value="${wish}" style="
                        width: 100%;
                        padding: 10px;
                        border-radius: 8px;
                        border: 1px solid var(--border-color);
                        background: var(--card-bg);
                        color: var(--text-color);
                        font-size: 15px;
                        margin-top: 6px;
                    " oninput="updateNeedsEditPreview()">
                </div>
                
                <!-- プレビュー -->
                <div id="needsEditPreview" style="
                    margin-bottom: 16px;
                    padding: 14px;
                    background: linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(139,92,246,0.2) 100%);
                    border-radius: 10px;
                    font-size: 15px;
                    font-weight: 600;
                    color: #ffffff;
                    border: 1px solid rgba(99,102,241,0.3);
                ">
                    → ${state}${wish ? `だが、${wish}` : ''}
                </div>
                
                <div style="display: flex; gap: 12px;">
                    <button class="btn btn-secondary" style="flex: 1;" onclick="closeFieldEditModal()">
                        キャンセル
                    </button>
                    <button class="btn btn-primary" style="flex: 1;" onclick="saveNeedsEdit(${index})">
                        保存
                    </button>
                </div>
            </div>
        `;
    } else {
        // 通常のテキストエリア編集
        modal.innerHTML = `
            <div style="
                background: var(--bg-color);
                border-radius: 16px;
                max-width: 500px;
                width: 100%;
                padding: 24px;
                max-height: 90vh;
                overflow-y: auto;
            ">
                <h2 style="margin-bottom: 16px; color: var(--text-color);">✏️ ${fieldLabel}を編集</h2>
                <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
                    「${item.categoryName}」の${fieldLabel}を編集します
                </p>
                
                <div class="form-group">
                    <textarea id="fieldEditText" class="form-textarea" style="min-height: 120px; width: 100%; font-size: 15px;">${currentValue}</textarea>
                </div>
                
                <div style="display: flex; gap: 12px;">
                    <button class="btn btn-secondary" style="flex: 1;" onclick="closeFieldEditModal()">
                        キャンセル
                    </button>
                    <button class="btn btn-primary" style="flex: 1;" onclick="saveFieldEdit(${index}, '${field}')">
                        保存
                    </button>
                </div>
            </div>
        `;
    }

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeFieldEditModal();
        }
    });

    // ニーズ編集の場合、選択イベントを設定
    if (field === 'needs') {
        const select = document.getElementById('needsStateSelect');
        const customInput = document.getElementById('needsCustomState');
        if (select && customInput) {
            select.addEventListener('change', () => {
                if (select.value === '__custom__') {
                    customInput.style.display = 'block';
                    customInput.focus();
                } else {
                    customInput.style.display = 'none';
                }
                updateNeedsEditPreview();
            });
        }
    }
}

// ニーズ編集プレビュー更新
function updateNeedsEditPreview() {
    const select = document.getElementById('needsStateSelect');
    const customInput = document.getElementById('needsCustomState');
    const wishInput = document.getElementById('needsWish');
    const preview = document.getElementById('needsEditPreview');

    if (!select || !preview) return;

    let state = select.value === '__custom__' ? (customInput?.value || '') : select.value;
    let wish = wishInput?.value || '';

    let fullNeeds = state;
    if (wish.trim()) {
        fullNeeds = `${state}だが、${wish}`;
    }

    preview.textContent = `→ ${fullNeeds}`;
}

// ニーズ保存
function saveNeedsEdit(index) {
    const select = document.getElementById('needsStateSelect');
    const customInput = document.getElementById('needsCustomState');
    const wishInput = document.getElementById('needsWish');

    if (!select) return;

    let state = select.value === '__custom__' ? (customInput?.value || '') : select.value;
    let wish = wishInput?.value || '';

    let fullNeeds = state;
    if (wish.trim()) {
        fullNeeds = `${state}だが、${wish}`;
    }

    if (fullNeeds.trim()) {
        carePlanItems[index].needs = fullNeeds;
        renderCarePlan();
        showToast('ニーズを更新しました');
    }
    closeFieldEditModal();
}

function closeFieldEditModal() {
    const modal = document.getElementById('fieldEditModal');
    if (modal) modal.remove();
}

function saveFieldEdit(index, field) {
    const textArea = document.getElementById('fieldEditText');
    if (!textArea) return;

    const newValue = textArea.value.trim();
    if (newValue) {
        carePlanItems[index][field] = newValue;
        renderCarePlan();
        showToast('保存しました');
    }
    closeFieldEditModal();
}

async function applyFieldStyle(index, field, style) {
    const textArea = document.getElementById('fieldEditText');
    if (!textArea) return;

    const currentValue = textArea.value.trim();
    if (!currentValue) {
        alert('編集する内容がありません');
        return;
    }

    const fieldLabel = FIELD_LABELS[field] || field;

    const styleInstructions = {
        concise: `以下の${fieldLabel}を短く簡潔に書き直してください。要点を絞り、無駄な言葉を省いてください。`,
        polite: `以下の${fieldLabel}を丁寧な表現に書き直してください。利用者様への配慮を示す表現を使ってください。`,
        specific: `以下の${fieldLabel}をより具体的に書き直してください。具体的な方法や回数、時間などを追加してください。`
    };

    const prompt = `${styleInstructions[style]}

【編集対象】
${currentValue}

書き直した結果のみを出力してください（説明不要）。`;

    closeFieldEditModal();
    showLoading(true);

    try {
        const response = await callAI(prompt, false);
        // レスポンスから余計な部分を除去
        const cleanedResponse = response.replace(/```.*?```/gs, '').trim();

        // 結果を反映
        carePlanItems[index][field] = cleanedResponse;
        renderCarePlan();
        showToast('AIで書き換えました');
    } catch (error) {
        console.error('編集エラー:', error);
        alert(`エラー: ${error.message}`);
    } finally {
        showLoading(false);
    }
}

// 旧関数（互換性のため残す）
function showEditStyleModal(index) {
    showFieldEditModal(index, 'needs');
}

function closeEditStyleModal() {
    closeFieldEditModal();
}

async function applyEditStyle(index, style) {
    const item = carePlanItems[index];
    if (!item) return;

    closeEditStyleModal();
    showLoading(true);

    const styleInstructions = {
        concise: '以下の内容を短く簡潔に書き直してください。要点を絞り、無駄な言葉を省いてください。',
        polite: '以下の内容を丁寧な敬語表現に書き直してください。利用者様への配慮を示す表現を使ってください。',
        specific: '以下の内容をより具体的に書き直してください。具体的な方法や回数、時間などを追加してください。'
    };

    const prompt = `${styleInstructions[style]}

【編集対象】
ニーズ: ${item.needs}
長期目標: ${item.longTermGoal}
短期目標: ${item.shortTermGoal}
サービス内容: ${item.serviceContent}

以下の形式で出力してください：
ニーズ: （編集後）
長期目標: （編集後）
短期目標: （編集後）
サービス内容: （編集後）`;

    try {
        const response = await callAI(prompt, false);
        const editedItem = parseEditedResponse(response);

        if (editedItem) {
            carePlanItems[index] = {
                ...item,
                needs: editedItem.needs || item.needs,
                longTermGoal: editedItem.longTermGoal || item.longTermGoal,
                shortTermGoal: editedItem.shortTermGoal || item.shortTermGoal,
                serviceContent: editedItem.serviceContent || item.serviceContent
            };
            renderCarePlan();
            showToast('編集が完了しました');
        } else {
            alert('AIからの応答を解析できませんでした');
        }
    } catch (error) {
        console.error('編集エラー:', error);
        alert(`エラー: ${error.message}`);
    } finally {
        showLoading(false);
    }
}

function parseEditedResponse(text) {
    console.log('parseEditedResponse に渡された値:', typeof text, text);
    if (typeof text === 'object' && text !== null) {
        return {
            needs: text.needs || null,
            longTermGoal: text.longTermGoal || null,
            shortTermGoal: text.shortTermGoal || null,
            serviceContent: text.serviceContent || null
        };
    }
    if (typeof text !== 'string') return null;
    try {
        const cleanedText = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.needs || parsed.longTermGoal) {
                return {
                    needs: parsed.needs || null,
                    longTermGoal: parsed.longTermGoal || null,
                    shortTermGoal: parsed.shortTermGoal || null,
                    serviceContent: parsed.serviceContent || null
                };
            }
        }
    } catch (e) { }
    const needsMatch = text.match(/ニーズ[:：]\s*(.+)/);
    const longTermMatch = text.match(/長期目標[:：]\s*(.+)/);
    const shortTermMatch = text.match(/短期目標[:：]\s*(.+)/);
    const serviceMatch = text.match(/サービス内容[:：]\s*(.+)/);
    if (needsMatch && longTermMatch && shortTermMatch) {
        return {
            needs: needsMatch[1].trim(),
            longTermGoal: longTermMatch[1].trim(),
            shortTermGoal: shortTermMatch[1].trim(),
            serviceContent: serviceMatch ? serviceMatch[1].trim() : null
        };
    }
    return null;
}


// ========================================
// エクスポート
// ========================================
function copyToClipboard() {
    if (carePlanItems.length === 0) return;

    let text = `【${SERVICE_TYPES[selectedServiceType]?.planName || 'サービス計画書'}】\n\n`;

    carePlanItems.forEach((item, index) => {
        text += `■ ${index + 1}. ${item.categoryName}\n`;
        text += `【ニーズ】${item.needs}\n`;
        text += `【長期目標】${item.longTermGoal}\n`;
        text += `【短期目標】${item.shortTermGoal}\n`;
        text += `【サービス内容】${item.serviceContent}\n\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
        alert('クリップボードにコピーしました');
    });
}

function exportToCSV() {
    if (carePlanItems.length === 0) return;

    const BOM = '\uFEFF';
    let csv = 'No.,カテゴリ,ニーズ,長期目標,短期目標,サービス内容\n';

    carePlanItems.forEach((item, index) => {
        const row = [
            index + 1,
            escapeCSV(item.categoryName),
            escapeCSV(item.needs),
            escapeCSV(item.longTermGoal),
            escapeCSV(item.shortTermGoal),
            escapeCSV(item.serviceContent)
        ];
        csv += row.join(',') + '\n';
    });

    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ケアプラン_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function escapeCSV(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// ========================================
// ローディング
// ========================================
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.toggle('hidden', !show);
    }

    if (show && useLocalAI) {
        updatePrivacyBadge(true, '端末内でAI処理中... インターネット接続は使用していません');
    }
}

// ========================================
// 設定
// ========================================
function openSettings() {
    showScreen('settingsScreen');

    try {
        document.getElementById('apiKeyInput').value = apiKey || '';
    } catch (e) {
        console.error('APIキー入力欄の設定エラー:', e);
    }

    // 必須サービス内容の設定欄を生成
    try {
        renderRequiredServiceSettings();
    } catch (e) {
        console.error('必須サービス設定の生成エラー:', e);
    }
}

function saveSettings() {
    apiKey = document.getElementById('apiKeyInput').value.trim();
    localStorage.setItem('geminiApiKey', apiKey);
    alert('設定を保存しました');
    showScreen('homeScreen');
}

// 必須サービス内容の設定欄を生成
function renderRequiredServiceSettings() {
    const container = document.getElementById('requiredServiceSettings');
    if (!container) {
        console.warn('requiredServiceSettings要素が見つかりません');
        return;
    }

    // INTEGRATED_CATEGORIESが定義されているか確認
    if (typeof INTEGRATED_CATEGORIES === 'undefined') {
        console.error('INTEGRATED_CATEGORIESが定義されていません');
        container.innerHTML = '<p style="color: red;">カテゴリデータの読み込みに失敗しました。ページを再読み込みしてください。</p>';
        return;
    }

    // 保存された必須サービス内容を読み込む
    let savedRequiredServices = {};
    try {
        savedRequiredServices = JSON.parse(localStorage.getItem('requiredServices') || '{}');
    } catch (e) {
        console.error('必須サービス内容の読み込みエラー:', e);
    }

    const html = Object.entries(INTEGRATED_CATEGORIES).map(([key, category]) => `
        <div style="margin-bottom: 16px; padding: 12px; background: var(--card-bg); border-radius: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-weight: 500;">
                <span style="font-size: 20px;">${category.icon || '📋'}</span>
                ${category.name || key}
            </label>
            <textarea 
                id="requiredService-${key}" 
                class="form-textarea" 
                placeholder="例: モニタリング実施、記録作成"
                style="min-height: 60px; font-size: 14px;"
            >${savedRequiredServices[key] || ''}</textarea>
        </div>
    `).join('');

    container.innerHTML = html;
}

// 必須サービス内容を保存
function saveRequiredServices() {
    const requiredServices = {};

    Object.keys(INTEGRATED_CATEGORIES).forEach(key => {
        const textarea = document.getElementById(`requiredService-${key}`);
        if (textarea && textarea.value.trim()) {
            requiredServices[key] = textarea.value.trim();
        }
    });

    localStorage.setItem('requiredServices', JSON.stringify(requiredServices));
    showToast('必須サービス内容を保存しました');
}

// 必須サービス内容を取得
function getRequiredService(categoryKey) {
    const savedRequiredServices = JSON.parse(localStorage.getItem('requiredServices') || '{}');
    return savedRequiredServices[categoryKey] || '';
}

// ========================================
// 手動入力モーダル
// ========================================
function openManualEntryModal() {
    saveCurrentCategoryData();

    const category = ASSESSMENT_CATEGORIES[currentCategoryIndex];

    const modal = document.createElement('div');
    modal.id = 'manualEntryModal';
    modal.className = 'loading-overlay';
    modal.innerHTML = `
        <div class="loading-content" style="max-width: 500px; width: 90%; max-height: 90vh; overflow-y: auto; text-align: left;">
            <h3 style="margin-bottom: 16px;">${category.name} - 手動入力</h3>
            
            <div class="form-group">
                <label class="form-label">ニーズ（生活全般の解決すべき課題）</label>
                <textarea class="form-textarea" id="manualNeeds" placeholder="〜〜だが、〜〜したい" style="min-height: 60px;"></textarea>
            </div>
            
            <div class="form-group">
                <label class="form-label">長期目標（55文字以内）</label>
                <input type="text" class="form-input" id="manualLongTerm" placeholder="〜〜できる" maxlength="55">
            </div>
            
            <div class="form-group">
                <label class="form-label">短期目標（55文字以内）</label>
                <input type="text" class="form-input" id="manualShortTerm" placeholder="〜〜できる" maxlength="55">
            </div>
            
            <div class="form-group">
                <label class="form-label">サービス内容</label>
                <textarea class="form-textarea" id="manualService" placeholder="サービス内容を入力" style="min-height: 60px;"></textarea>
            </div>
            
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button class="btn btn-secondary" style="flex: 1;" onclick="closeManualEntryModal()">キャンセル</button>
                <button class="btn btn-primary" style="flex: 1;" onclick="saveManualEntry('${category.name}')">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function closeManualEntryModal() {
    const modal = document.getElementById('manualEntryModal');
    if (modal) {
        modal.remove();
    }
}

function saveManualEntry(categoryName) {
    const needs = document.getElementById('manualNeeds').value.trim();
    const longTermGoal = document.getElementById('manualLongTerm').value.trim();
    const shortTermGoal = document.getElementById('manualShortTerm').value.trim();
    const serviceContent = document.getElementById('manualService').value.trim();

    if (!needs || !longTermGoal || !shortTermGoal) {
        alert('ニーズ・長期目標・短期目標は必須です');
        return;
    }

    carePlanItems.push({
        categoryName,
        needs,
        longTermGoal,
        shortTermGoal,
        serviceContent
    });

    closeManualEntryModal();
    showScreen('carePlanScreen');
}

// ========================================
// 自動提案機能（API不要）
// ========================================
function showSuggestions() {
    // 現在のカテゴリのチェック項目を取得
    saveCurrentCategoryData();
    const category = ASSESSMENT_CATEGORIES[currentCategoryIndex];
    const data = assessmentData[category.id] || { checkedItems: [], detailText: '' };

    if (data.checkedItems.length === 0) {
        alert('項目をチェックしてから「提案を表示」をクリックしてください');
        return;
    }

    // チェック項目に対応するテンプレートを取得
    const suggestions = [];
    data.checkedItems.forEach(item => {
        if (ITEM_TEMPLATES && ITEM_TEMPLATES[item]) {
            const template = ITEM_TEMPLATES[item];

            // 具体的内容がある場合はサービス内容に追加
            let serviceContent = template.serviceContent;
            if (data.detailText && data.detailText.trim()) {
                serviceContent = `${serviceContent}【詳細】${data.detailText.trim()}`;
            }

            suggestions.push({
                itemName: item,
                needs: template.needs,
                longTermGoal: template.longTermGoal,
                shortTermGoal: template.shortTermGoal,
                serviceContent: serviceContent,
                detailText: data.detailText || ''
            });
        }
    });

    if (suggestions.length === 0) {
        alert('選択した項目に対応する提案が見つかりませんでした');
        return;
    }

    // 提案モーダルを表示
    showSuggestionModal(category.name, suggestions);
}

function showSuggestionModal(categoryName, suggestions) {
    const modal = document.createElement('div');
    modal.id = 'suggestionModal';
    modal.className = 'modal-overlay';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        overflow-y: auto;
    `;

    // ニーズ文言を「状態」と「希望」に分離する
    const processedSuggestions = suggestions.map((suggestion, index) => {
        // 「〜〜だが、〇〇したい」形式を分離
        const needs = suggestion.needs || '';
        let state = '';
        let wish = '';

        if (needs.includes('だが、')) {
            const parts = needs.split('だが、');
            state = parts[0];
            wish = parts[1] || '';
        } else if (needs.includes('だが')) {
            const parts = needs.split('だが');
            state = parts[0];
            wish = parts[1] || '';
        } else {
            state = needs;
            wish = '';
        }

        // 状態の候補を生成（チェック項目名 + バリエーション）
        const itemName = suggestion.itemName || '';
        const stateSuggestions = generateStateSuggestions(itemName, state);

        return {
            ...suggestion,
            state,
            wish,
            stateSuggestions
        };
    });

    const suggestionsHtml = processedSuggestions.map((suggestion, index) => `
        <div class="suggestion-card" style="
            background: var(--card-bg);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 16px;
            border: 2px solid var(--primary-color);
        " id="suggestion-${index}">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                <input type="checkbox" id="suggestionCheck-${index}" checked style="width: 20px; height: 20px;" onclick="event.stopPropagation(); toggleSuggestionSelect(${index})">
                <strong style="color: var(--primary-color);">${suggestion.itemName}</strong>
            </div>
            <div style="font-size: 15px; line-height: 1.8;">
                <!-- ニーズ（ハイブリッドUI） -->
                <div style="margin-bottom: 16px; padding: 16px; background: #1e1e2e; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="color: #a0a0ff; margin-bottom: 10px; font-weight: 700; font-size: 16px;">📝 ニーズ：</div>
                    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px;">
                        <select id="stateSelect-${index}" onchange="updateNeedsPreview(${index})" style="
                            padding: 8px;
                            border-radius: 6px;
                            border: 1px solid var(--border-color);
                            background: var(--card-bg);
                            color: var(--text-color);
                            font-size: 14px;
                            flex: 1;
                            min-width: 150px;
                        ">
                            ${suggestion.stateSuggestions.map((s, i) => `<option value="${s}" ${i === 0 ? 'selected' : ''}>${s}</option>`).join('')}
                            <option value="__custom__">✏️ 自由入力...</option>
                        </select>
                        <span style="color: var(--text-secondary);">だが、</span>
                        <span style="color: var(--text-color);">${suggestion.wish}</span>
                    </div>
                    <input type="text" id="customState-${index}" placeholder="状態を入力（例：〇〇が困難）" style="
                        display: none;
                        width: 100%;
                        margin-top: 8px;
                        padding: 8px;
                        border-radius: 6px;
                        border: 1px solid var(--border-color);
                        background: var(--card-bg);
                        color: var(--text-color);
                        font-size: 14px;
                    " oninput="updateNeedsPreview(${index})">
                    <div id="needsPreview-${index}" style="
                        margin-top: 12px;
                        padding: 12px;
                        background: linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(139,92,246,0.2) 100%);
                        border-radius: 8px;
                        font-size: 15px;
                        font-weight: 600;
                        color: #ffffff;
                        border: 1px solid rgba(99,102,241,0.3);
                    ">
                        → ${suggestion.state}だが、${suggestion.wish}
                    </div>
                </div>
                
                <div style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #80d0ff; font-weight: 600;">長期目標：</span>
                    <span style="color: #ffffff;">${suggestion.longTermGoal}</span>
                </div>
                <div style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #80ffa0; font-weight: 600;">短期目標：</span>
                    <span style="color: #ffffff;">${suggestion.shortTermGoal}</span>
                </div>
                <div style="padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #ffcc80; font-weight: 600;">サービス：</span>
                    <span style="color: #ffffff;">${suggestion.serviceContent}</span>
                </div>
            </div>
        </div>
    `).join('');

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 8px; color: var(--text-color);">✨ 提案内容</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                ${categoryName}のチェック項目から自動生成しました。<br>
                <strong style="color: var(--primary-color);">💡 ニーズの「状態」部分を選択・編集できます</strong>
            </p>
            
            <div id="suggestionList">
                ${suggestionsHtml}
            </div>
            
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button class="btn btn-secondary" style="flex: 1;" onclick="closeSuggestionModal()">
                    キャンセル
                </button>
                <button class="btn btn-primary" style="flex: 1;" onclick="addSelectedSuggestions()">
                    選択した項目を追加
                </button>
            </div>
            
            <p style="color: var(--text-secondary); font-size: 12px; text-align: center; margin-top: 16px;">
                💡 追加後に第2表でさらに編集できます
            </p>
        </div>
    `;

    // グローバルに提案データを保存（状態と希望を分離済み）
    window.currentSuggestions = processedSuggestions;

    document.body.appendChild(modal);

    // モーダル外クリックで閉じる
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSuggestionModal();
        }
    });
}

// 状態の候補を生成する関数
function generateStateSuggestions(itemName, defaultState) {
    // 基本候補
    const suggestions = [defaultState];

    // チェック項目名に基づく追加候補
    const additionalSuggestions = {
        '歩行が不安定': ['ふらつきがある', 'すり足になっている', '歩行時にバランスを崩しやすい'],
        '転倒リスクがある': ['足元がふらつく', '転倒の恐れがある', '足腰が弱っている'],
        '物忘れがある': ['短期記憶が低下している', '最近のことを忘れやすい', '何度も同じことを聞く'],
        '見当識障害がある': ['日時や場所がわからなくなる', '時間の感覚が曖昧である', '自分の居場所がわからない'],
        '尿失禁がある': ['尿意を感じにくい', 'トイレが間に合わないことがある', '排尿のコントロールが難しい'],
        '便秘傾向がある': ['排便が不規則である', '便が硬くなりやすい', '排便に苦労することがある'],
        '食欲不振がある': ['食事への意欲が低下している', '食べる量が減っている', '食事を残すことが多い'],
        '嚥下困難がある': ['飲み込みにくさがある', 'むせやすい', '食事に時間がかかる'],
        '口腔内の清潔保持が困難': ['自分で歯磨きが難しい', '口腔ケアに介助が必要', '口腔内が乾燥しやすい'],
        '褥瘡リスクが高い': ['皮膚が弱い', '同じ姿勢が続きやすい', '体圧分散が必要'],
        '外出機会が少ない': ['家にこもりがち', '外に出る機会がない', '外出への意欲が低い'],
        '閉じこもりがち': ['人との交流が少ない', '家から出たがらない', '活動量が減っている'],
        '聴力の低下がある': ['耳が遠くなっている', '会話が聞き取りにくい', '大きな声でないと聞こえない'],
        '視力の低下がある': ['目が見えにくい', '細かいものが見えにくい', '視野が狭くなっている']
    };

    // 追加候補があれば追加
    if (additionalSuggestions[itemName]) {
        suggestions.push(...additionalSuggestions[itemName]);
    }

    // 重複を除去
    return [...new Set(suggestions)];
}

// ニーズのプレビューを更新する関数
function updateNeedsPreview(index) {
    const select = document.getElementById(`stateSelect-${index}`);
    const customInput = document.getElementById(`customState-${index}`);
    const preview = document.getElementById(`needsPreview-${index}`);

    if (!select || !preview) return;

    const suggestion = window.currentSuggestions[index];
    let state = '';

    if (select.value === '__custom__') {
        // 自由入力モード
        customInput.style.display = 'block';
        state = customInput.value || '（状態を入力）';
    } else {
        // 選択モード
        customInput.style.display = 'none';
        state = select.value;
    }

    // プレビュー更新
    preview.textContent = `→ ${state}だが、${suggestion.wish}`;

    // 選択した状態を保存
    window.currentSuggestions[index].selectedState = state;
}

function toggleSuggestionSelect(index) {
    const checkbox = document.getElementById(`suggestionCheck-${index}`);
    const card = document.getElementById(`suggestion-${index}`);

    if (checkbox && card) {
        checkbox.checked = !checkbox.checked;
        card.style.borderColor = checkbox.checked ? 'var(--primary-color)' : 'transparent';
        card.style.opacity = checkbox.checked ? '1' : '0.6';
    }
}

function closeSuggestionModal() {
    const modal = document.getElementById('suggestionModal');
    if (modal) {
        modal.remove();
    }
    window.currentSuggestions = null;
}

function addSelectedSuggestions() {
    const suggestions = window.currentSuggestions || [];
    let addedCount = 0;

    suggestions.forEach((suggestion, index) => {
        const checkbox = document.getElementById(`suggestionCheck-${index}`);
        if (checkbox && checkbox.checked) {
            // ユーザーが選択・編集した状態を取得
            const select = document.getElementById(`stateSelect-${index}`);
            const customInput = document.getElementById(`customState-${index}`);

            let state = suggestion.state; // デフォルト

            if (select) {
                if (select.value === '__custom__' && customInput) {
                    state = customInput.value || suggestion.state;
                } else if (select.value !== '__custom__') {
                    state = select.value;
                }
            }

            // 状態と希望を組み合わせてニーズを作成
            const needs = `${state}だが、${suggestion.wish}`;

            carePlanItems.push({
                categoryName: suggestion.itemName,
                needs: needs,
                longTermGoal: suggestion.longTermGoal,
                shortTermGoal: suggestion.shortTermGoal,
                serviceContent: suggestion.serviceContent
            });
            addedCount++;
        }
    });

    closeSuggestionModal();

    if (addedCount > 0) {
        showScreen('carePlanScreen');
    } else {
        alert('項目を選択してください');
    }
}

// ========================================
// 統合生成モード（7カテゴリ一括生成）
// ========================================
function showIntegratedGenerationModal() {
    // すべてのアセスメントデータからチェック項目を収集
    const allCheckedItems = [];
    Object.values(assessmentData).forEach(data => {
        if (data.checkedItems) {
            allCheckedItems.push(...data.checkedItems);
        }
    });

    // 7カテゴリごとに該当項目を分類（すべてのカテゴリを表示）
    const categoryResults = {};
    Object.entries(INTEGRATED_CATEGORIES).forEach(([key, category]) => {
        const matchedItems = category.items.filter(item => allCheckedItems.includes(item));
        categoryResults[key] = {
            ...category,
            matchedItems: matchedItems,
            hasMatches: matchedItems.length > 0
        };
    });

    const modal = document.createElement('div');
    modal.id = 'integratedGenerationModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        overflow-y: auto;
    `;

    // 7カテゴリすべてを表示（該当項目があるものはチェック済み）
    const categoriesHtml = Object.entries(categoryResults).map(([key, category]) => `
        <div class="card" style="margin-bottom: 12px; padding: 16px; ${category.hasMatches ? '' : 'opacity: 0.7;'}">
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="intCat-${key}" ${category.hasMatches ? 'checked' : ''} style="width: 20px; height: 20px;">
                <span style="font-size: 24px;">${category.icon}</span>
                <div>
                    <strong style="color: var(--text-color);">${category.name}</strong>
                    <div style="font-size: 12px; color: var(--text-secondary);">
                        ${category.hasMatches ? `${category.matchedItems.length}項目該当` : '該当なし（推測で生成）'}
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 500px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 12px; color: var(--text-color);">🔄 すべてから統合生成</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 16px;">
                7つのカテゴリすべてを選択してケアプランを生成できます。<br>
                チェックをつけたカテゴリが計画書に追加されます。
            </p>
            
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <button class="btn btn-secondary" style="flex: 1; font-size: 12px;" onclick="selectAllIntegratedCategories(true)">
                    全選択
                </button>
                <button class="btn btn-secondary" style="flex: 1; font-size: 12px;" onclick="selectAllIntegratedCategories(false)">
                    全解除
                </button>
            </div>
            
            <div style="margin-bottom: 16px;">
                ${categoriesHtml}
            </div>
            
            <div style="background: var(--card-bg); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <div style="font-size: 13px; color: var(--text-secondary);">
                    💡 該当なしのカテゴリも選択すると、標準テンプレートで生成されます
                </div>
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="btn btn-success btn-block" onclick="generateIntegratedWithTemplate()">
                    ✨ テンプレートから生成（API不要）
                </button>
                ${apiKey || useLocalAI ? `
                    <button class="btn btn-primary btn-block" onclick="generateIntegratedWithApi()">
                        🤖 AIで生成${useLocalAI ? '（端末内処理）' : ''}
                    </button>
                ` : `
                    <button class="btn btn-secondary btn-block" disabled>
                        🤖 AIで生成（APIキー未設定）
                    </button>
                `}
                <button class="btn btn-secondary btn-block" onclick="closeIntegratedGenerationModal()">
                    キャンセル
                </button>
            </div>
        </div>
    `;

    // グローバルに結果を保存
    window.integratedCategoryResults = categoryResults;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeIntegratedGenerationModal();
        }
    });
}

// カテゴリの全選択/全解除
function selectAllIntegratedCategories(selectAll) {
    Object.keys(INTEGRATED_CATEGORIES).forEach(key => {
        const checkbox = document.getElementById(`intCat-${key}`);
        if (checkbox) {
            checkbox.checked = selectAll;
        }
    });
}

function closeIntegratedGenerationModal() {
    const modal = document.getElementById('integratedGenerationModal');
    if (modal) modal.remove();
    window.integratedCategoryResults = null;
}

function generateIntegratedWithTemplate() {
    // 選択されたカテゴリを収集
    const selectedCategories = [];
    const savedRequiredServices = JSON.parse(localStorage.getItem('requiredServices') || '{}');

    Object.entries(INTEGRATED_CATEGORIES).forEach(([key, intCategory]) => {
        const checkbox = document.getElementById(`intCat-${key}`);
        if (!checkbox || !checkbox.checked) return;

        if (intCategory.integratedTemplate) {
            const template = intCategory.integratedTemplate;

            // 必須サービス内容を追加
            let serviceContent = template.serviceContent;
            const requiredService = savedRequiredServices[key];
            if (requiredService) {
                serviceContent = `${serviceContent}、${requiredService}`;
            }

            selectedCategories.push({
                key: key,
                categoryName: `${intCategory.icon} ${intCategory.name}`,
                needs: template.needs,
                longTermGoal: template.longTermGoal,
                shortTermGoal: template.shortTermGoal,
                serviceContent: serviceContent
            });
        }
    });

    if (selectedCategories.length === 0) {
        alert('カテゴリを選択してください');
        return;
    }

    closeIntegratedGenerationModal();

    // ハイブリッドUI対応のモーダルを表示
    showIntegratedSuggestionModal(selectedCategories);
}

// 統合生成用のハイブリッドUI対応モーダル
function showIntegratedSuggestionModal(categories) {
    const modal = document.createElement('div');
    modal.id = 'integratedSuggestionModal';
    modal.className = 'modal-overlay';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        overflow-y: auto;
    `;

    // ニーズを「状態」と「希望」に分離
    const processedCategories = categories.map((cat, index) => {
        const needs = cat.needs || '';
        let state = '';
        let wish = '';

        if (needs.includes('だが、')) {
            const parts = needs.split('だが、');
            state = parts[0];
            wish = parts[1] || '';
        } else if (needs.includes('だが')) {
            const parts = needs.split('だが');
            state = parts[0];
            wish = parts[1] || '';
        } else {
            state = needs;
            wish = '';
        }

        const stateSuggestions = generateStateSuggestions(cat.categoryName.replace(/^[^\s]+\s/, ''), state);

        return {
            ...cat,
            index,
            state,
            wish,
            stateSuggestions,
            selectedState: state
        };
    });

    const categoriesHtml = processedCategories.map((cat, index) => `
        <div class="suggestion-card" style="
            background: var(--card-bg);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 16px;
            border: 2px solid var(--primary-color);
        " id="intSuggestion-${index}">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                <input type="checkbox" id="intSuggestionCheck-${index}" checked style="width: 20px; height: 20px;">
                <strong style="color: var(--primary-color); font-size: 16px;">${cat.categoryName}</strong>
            </div>
            <div style="font-size: 15px; line-height: 1.8;">
                <!-- ニーズ（ハイブリッドUI） -->
                <div style="margin-bottom: 16px; padding: 16px; background: #1e1e2e; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="color: #a0a0ff; margin-bottom: 10px; font-weight: 700; font-size: 16px;">📝 ニーズ：</div>
                    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px;">
                        <select id="intStateSelect-${index}" onchange="updateIntNeedsPreview(${index})" style="
                            padding: 8px;
                            border-radius: 6px;
                            border: 1px solid var(--border-color);
                            background: var(--card-bg);
                            color: var(--text-color);
                            font-size: 14px;
                            flex: 1;
                            min-width: 150px;
                        ">
                            ${cat.stateSuggestions.map((s, i) => `<option value="${s}" ${i === 0 ? 'selected' : ''}>${s}</option>`).join('')}
                            <option value="__custom__">✏️ 自由入力...</option>
                        </select>
                        <span style="color: var(--text-secondary);">だが、</span>
                        <span style="color: var(--text-color);">${cat.wish}</span>
                    </div>
                    <input type="text" id="intCustomState-${index}" placeholder="状態を入力（例：〇〇が困難）" style="
                        display: none;
                        width: 100%;
                        margin-top: 8px;
                        padding: 8px;
                        border-radius: 6px;
                        border: 1px solid var(--border-color);
                        background: var(--card-bg);
                        color: var(--text-color);
                        font-size: 14px;
                    " oninput="updateIntNeedsPreview(${index})">
                    <div id="intNeedsPreview-${index}" style="
                        margin-top: 12px;
                        padding: 12px;
                        background: linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(139,92,246,0.2) 100%);
                        border-radius: 8px;
                        font-size: 15px;
                        font-weight: 600;
                        color: #ffffff;
                        border: 1px solid rgba(99,102,241,0.3);
                    ">
                        → ${cat.state}だが、${cat.wish}
                    </div>
                </div>
                
                <div style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #80d0ff; font-weight: 600;">長期目標：</span>
                    <span style="color: #ffffff;">${cat.longTermGoal}</span>
                </div>
                <div style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #80ffa0; font-weight: 600;">短期目標：</span>
                    <span style="color: #ffffff;">${cat.shortTermGoal}</span>
                </div>
                <div style="padding: 10px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                    <span style="color: #ffcc80; font-weight: 600;">サービス：</span>
                    <span style="color: #ffffff;">${cat.serviceContent}</span>
                </div>
            </div>
        </div>
    `).join('');

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 8px; color: var(--text-color);">✨ 統合生成 - 提案内容</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                ${processedCategories.length}カテゴリのケアプランを生成します。<br>
                <strong style="color: var(--primary-color);">💡 ニーズの「状態」部分を選択・編集できます</strong>
            </p>
            
            <div id="intSuggestionList">
                ${categoriesHtml}
            </div>
            
            <div style="display: flex; justify-content: space-between; margin-top: 16px; gap: 12px;">
                <button class="btn btn-secondary" onclick="closeIntegratedSuggestionModal()" style="flex: 1; padding: 12px;">
                    キャンセル
                </button>
                <button class="btn btn-primary" onclick="addIntegratedSuggestions()" style="flex: 2; padding: 12px;">
                    ✅ 選択した項目を追加
                </button>
            </div>
        </div>
    `;

    // グローバルに保存
    window.integratedSuggestions = processedCategories;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeIntegratedSuggestionModal();
        }
    });
}

// 統合生成用のプレビュー更新
function updateIntNeedsPreview(index) {
    const select = document.getElementById(`intStateSelect-${index}`);
    const customInput = document.getElementById(`intCustomState-${index}`);
    const preview = document.getElementById(`intNeedsPreview-${index}`);

    if (!select || !preview) return;

    const cat = window.integratedSuggestions[index];
    let state = '';

    if (select.value === '__custom__') {
        customInput.style.display = 'block';
        state = customInput.value || '（状態を入力）';
    } else {
        customInput.style.display = 'none';
        state = select.value;
    }

    preview.textContent = `→ ${state}だが、${cat.wish}`;
    window.integratedSuggestions[index].selectedState = state;
}

// 統合生成モーダルを閉じる
function closeIntegratedSuggestionModal() {
    const modal = document.getElementById('integratedSuggestionModal');
    if (modal) modal.remove();
    window.integratedSuggestions = null;
}

// 統合生成の提案を追加
function addIntegratedSuggestions() {
    const categories = window.integratedSuggestions || [];

    // 統合生成は上書きモード：既存の計画項目をクリア
    carePlanItems = [];
    let addedCount = 0;

    categories.forEach((cat, index) => {
        const checkbox = document.getElementById(`intSuggestionCheck-${index}`);
        if (checkbox && checkbox.checked) {
            // ユーザーが選択・編集した状態を取得
            const select = document.getElementById(`intStateSelect-${index}`);
            const customInput = document.getElementById(`intCustomState-${index}`);

            let state = cat.state;

            if (select) {
                if (select.value === '__custom__' && customInput) {
                    state = customInput.value || cat.state;
                } else if (select.value !== '__custom__') {
                    state = select.value;
                }
            }

            const needs = `${state}だが、${cat.wish}`;

            carePlanItems.push({
                categoryName: cat.categoryName,
                needs: needs,
                longTermGoal: cat.longTermGoal,
                shortTermGoal: cat.shortTermGoal,
                serviceContent: cat.serviceContent
            });
            addedCount++;
        }
    });

    closeIntegratedSuggestionModal();

    if (addedCount > 0) {
        showToast(`${addedCount}カテゴリを追加しました`);
        showScreen('carePlanScreen');
    } else {
        alert('カテゴリを選択してください');
    }
}

async function generateIntegratedWithApi() {
    const categoryResults = window.integratedCategoryResults || {};

    // 統合生成は上書きモード：既存の計画項目をクリア
    carePlanItems = [];

    // 選択されたカテゴリのみ収集
    const selectedCategories = [];
    Object.entries(categoryResults).forEach(([key, category]) => {
        const checkbox = document.getElementById(`intCat-${key}`);
        if (checkbox && checkbox.checked) {
            selectedCategories.push({
                name: category.name,
                icon: category.icon,
                items: category.matchedItems
            });
        }
    });

    if (selectedCategories.length === 0) {
        alert('カテゴリを選択してください');
        return;
    }

    closeIntegratedGenerationModal();
    showLoading(true);

    try {
        // プロンプトを構築
        const prompt = buildIntegratedApiPrompt(selectedCategories);
        const response = await callAI(prompt, false);
        const items = parseIntegratedApiResponse(response, selectedCategories);

        if (items.length > 0) {
            carePlanItems.push(...items);
            showToast(`${items.length}項目を追加しました`);
            showScreen('carePlanScreen');
        } else {
            alert('AIからの応答を解析できませんでした');
        }
    } catch (error) {
        console.error('統合生成エラー:', error);
        alert(`エラー: ${error.message}\n\nテンプレート生成をお試しください。`);
    } finally {
        showLoading(false);
    }
}

function buildIntegratedApiPrompt(categories) {
    const categoryDescriptions = categories.map(cat =>
        `【${cat.icon} ${cat.name}】\n課題: ${cat.items.join('、')}`
    ).join('\n\n');

    return `あなたは介護支援専門員（ケアマネジャー）です。
以下のアセスメント結果をもとに、各カテゴリについてケアプランを作成してください。

${categoryDescriptions}

各カテゴリについて、以下のJSON配列の形式のみで出力してください（マークダウンや余計なテキストは不要です）：

[
  {
    "categoryName": "（アイコン付きのカテゴリ名。例：【🏥 医療・健康】）",
    "needs": "（本人の希望を含めた課題）",
    "longTermGoal": "（6ヶ月〜1年の目標）",
    "shortTermGoal": "（3ヶ月程度の目標）",
    "serviceContent": "（具体的な援助内容）"
  },
  ...
]

すべてのカテゴリについて出力してください。`;
}

function parseIntegratedApiResponse(text, categories) {
    const items = [];

    // JSONとして直接パースできるか試みる（API側でJSON出力に固定したため）
    if (typeof text === 'string') {
        try {
            const parsedArray = JSON.parse(text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
            if (Array.isArray(parsedArray)) {
                return parsedArray.map(item => ({
                    categoryName: item.categoryName || '未分類',
                    needs: item.needs || '',
                    longTermGoal: item.longTermGoal || '',
                    shortTermGoal: item.shortTermGoal || '',
                    serviceContent: item.serviceContent || '個別対応'
                }));
            }
        } catch (e) {
            console.warn('JSON直接解析失敗、正規表現による解析を試みます:', e);
        }
    }

    if (typeof text !== 'string') {
        console.error('parseIntegratedApiResponse: textが文字列ではありません', text);
        return items;
    }

    categories.forEach(category => {
        // カテゴリ名でセクションを探す
        const regex = new RegExp(`【[^】]*${category.name}[^】]*】([\\s\\S]*?)(?=【|$)`, 'i');
        const match = text.match(regex);

        if (match) {
            const section = match[1];

            const needsMatch = section.match(/ニーズ[:：]\s*(.+)/);
            const longTermMatch = section.match(/長期目標[:：]\s*(.+)/);
            const shortTermMatch = section.match(/短期目標[:：]\s*(.+)/);
            const serviceMatch = section.match(/サービス内容[:：]\s*(.+)/);

            if (needsMatch && longTermMatch && shortTermMatch) {
                items.push({
                    categoryName: `${category.icon} ${category.name}`,
                    needs: needsMatch[1].trim(),
                    longTermGoal: longTermMatch[1].trim(),
                    shortTermGoal: shortTermMatch[1].trim(),
                    serviceContent: serviceMatch ? serviceMatch[1].trim() : '個別対応'
                });
            }
        }
    });

    return items;
}


// ========================================
// 利用者管理機能
// ========================================
function renderUserList() {
    const container = document.getElementById('userListContent');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = `
            <div class="card text-center">
                <p style="color: var(--text-secondary);">登録されている利用者はいません</p>
                <p style="font-size: 14px; color: var(--text-secondary);">「新規利用者を登録」から追加してください</p>
            </div>
        `;
        return;
    }

    const html = users.map(user => {
        const planCount = savedCarePlans.filter(p => p.userId === user.id).length;
        return `
            <div class="card user-card" style="cursor: pointer;" onclick="selectUser('${user.id}')">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 20px; font-weight: 600; color: var(--primary-color);">
                            ${user.initial}
                        </div>
                        <div style="font-size: 14px; color: var(--text-secondary); margin-top: 4px;">
                            ${user.age}歳 / ${user.careLevel}
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 12px; color: var(--text-secondary);">
                            計画書: ${planCount}件
                        </div>
                        <button class="btn btn-small btn-danger" onclick="event.stopPropagation(); deleteUser('${user.id}')" style="margin-top: 8px; padding: 4px 12px; font-size: 12px;">
                            削除
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function openUserAddModal() {
    const modal = document.createElement('div');
    modal.id = 'userAddModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 20px; color: var(--text-color);">👤 新規利用者登録</h2>
            
            <div class="form-group">
                <label class="form-label">イニシャル（例: Y.T）</label>
                <input type="text" class="form-input" id="userInitial" placeholder="Y.T" maxlength="10">
            </div>
            
            <div class="form-group">
                <label class="form-label">年齢</label>
                <input type="number" class="form-input" id="userAge" placeholder="85" min="0" max="120">
            </div>
            
            <div class="form-group">
                <label class="form-label">要介護度</label>
                <select class="form-input" id="userCareLevel">
                    <option value="要支援1">要支援1</option>
                    <option value="要支援2">要支援2</option>
                    <option value="要介護1">要介護1</option>
                    <option value="要介護2">要介護2</option>
                    <option value="要介護3" selected>要介護3</option>
                    <option value="要介護4">要介護4</option>
                    <option value="要介護5">要介護5</option>
                </select>
            </div>
            
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button class="btn btn-secondary" style="flex: 1;" onclick="closeUserAddModal()">キャンセル</button>
                <button class="btn btn-primary" style="flex: 1;" onclick="saveNewUser()">登録</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeUserAddModal();
        }
    });
}

function closeUserAddModal() {
    const modal = document.getElementById('userAddModal');
    if (modal) modal.remove();
}

function saveNewUser() {
    const initial = document.getElementById('userInitial').value.trim();
    const age = parseInt(document.getElementById('userAge').value) || 0;
    const careLevel = document.getElementById('userCareLevel').value;

    if (!initial) {
        alert('イニシャルを入力してください');
        return;
    }

    if (age < 0 || age > 120) {
        alert('年齢を正しく入力してください');
        return;
    }

    const newUser = {
        id: Date.now().toString(),
        initial,
        age,
        careLevel,
        createdAt: new Date().toISOString()
    };

    users.push(newUser);
    localStorage.setItem('careplan_users', JSON.stringify(users));

    closeUserAddModal();
    renderUserList();
}

function selectUser(userId) {
    currentUserId = userId;
    const user = users.find(u => u.id === userId);

    if (user) {
        // 途中保存データがあるか確認
        const progressKey = `assessment_progress_${userId}`;
        const savedProgress = localStorage.getItem(progressKey);

        if (savedProgress) {
            // 途中保存データがある場合
            try {
                const data = JSON.parse(savedProgress);
                const savedDate = new Date(data.savedAt).toLocaleString('ja-JP');

                if (confirm(`${user.initial}さんの途中保存データがあります\n（${savedDate}）\n\n続きから再開しますか？`)) {
                    assessmentData = data.assessmentData || {};
                    selectedServiceType = data.selectedServiceType;
                    currentCategoryIndex = data.currentCategoryIndex || 0;
                    carePlanItems = [];
                    currentPlanId = null;
                    showScreen('assessmentScreen');
                    updateCurrentUserBanner();
                    return;
                }
            } catch (e) {
                console.error('途中保存データの読み込みエラー:', e);
            }
        }

        // 利用者の保存済み計画書があるか確認
        const userPlans = savedCarePlans.filter(p => p.userId === userId);

        if (userPlans.length > 0) {
            // 計画書がある場合は選択モーダルを表示
            showUserPlanSelectModal(user, userPlans);
        } else {
            // 計画書がない場合は新規作成へ
            showScreen('homeScreen');
        }
    }
}

function showUserPlanSelectModal(user, plans) {
    const modal = document.createElement('div');
    modal.id = 'planSelectModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    const planListHtml = plans.map(plan => {
        const date = new Date(plan.updatedAt).toLocaleDateString('ja-JP');
        return `
            <div class="card" style="margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="cursor: pointer; flex: 1;" onclick="loadCarePlan('${plan.id}')">
                        <div style="font-weight: 600;">${SERVICE_TYPES[plan.serviceType]?.name || plan.serviceType}</div>
                        <div style="font-size: 12px; color: var(--text-secondary);">${plan.items.length}項目 / ${date}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px;" onclick="event.stopPropagation(); deleteCarePlan('${plan.id}')">
                            🗑️
                        </button>
                        <span style="color: var(--primary-color); cursor: pointer;" onclick="loadCarePlan('${plan.id}')">→</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
            max-height: 80vh;
            overflow-y: auto;
        ">
            <h2 style="margin-bottom: 8px; color: var(--text-color);">${user.initial}さんの計画書</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                読み込む計画書を選択するか、新規作成してください
            </p>
            
            ${planListHtml}
            
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button class="btn btn-secondary" style="flex: 1;" onclick="closePlanSelectModal()">キャンセル</button>
                <button class="btn btn-primary" style="flex: 1;" onclick="closePlanSelectModal(); showScreen('homeScreen')">新規作成</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closePlanSelectModal();
        }
    });
}

function closePlanSelectModal() {
    const modal = document.getElementById('planSelectModal');
    if (modal) modal.remove();
}

function loadCarePlan(planId) {
    const plan = savedCarePlans.find(p => p.id === planId);
    if (plan) {
        currentPlanId = planId; // 編集中の計画書を設定
        selectedServiceType = plan.serviceType;
        carePlanItems = [...plan.items];
        assessmentData = plan.assessmentData || {};
        closePlanSelectModal();
        showScreen('carePlanScreen');
    }
}

function deleteCarePlan(planId) {
    // iOS対応: カスタム確認モーダルを表示
    showDeleteConfirmModal(planId, 'plan');
}

function showDeleteConfirmModal(targetId, type) {
    const modal = document.createElement('div');
    modal.id = 'deleteConfirmModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1100;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    const title = type === 'plan' ? '計画書を削除' : '利用者を削除';
    const message = type === 'plan'
        ? 'この計画書を削除しますか？'
        : 'この利用者を削除しますか？関連する計画書も削除されます。';

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 350px;
            width: 100%;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 12px; color: var(--text-color);">🗑️ ${title}</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                ${message}
            </p>
            
            <div style="display: flex; gap: 12px;">
                <button class="btn btn-secondary" style="flex: 1;" onclick="closeDeleteConfirmModal()">
                    キャンセル
                </button>
                <button class="btn btn-danger" style="flex: 1;" onclick="closeDeleteConfirmModal(); doDelete('${targetId}', '${type}')">
                    削除する
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeDeleteConfirmModal();
        }
    });
}

function closeDeleteConfirmModal() {
    const modal = document.getElementById('deleteConfirmModal');
    if (modal) modal.remove();
}

function doDelete(targetId, type) {
    if (type === 'plan') {
        savedCarePlans = savedCarePlans.filter(p => p.id !== targetId);
        localStorage.setItem('careplan_plans', JSON.stringify(savedCarePlans));

        if (currentPlanId === targetId) {
            currentPlanId = null;
        }

        // モーダルを再描画
        closePlanSelectModal();

        // 計画書が残っている場合はモーダルを再表示
        const user = users.find(u => u.id === currentUserId);
        const userPlans = savedCarePlans.filter(p => p.userId === currentUserId);
        if (user && userPlans.length > 0) {
            showUserPlanSelectModal(user, userPlans);
        }

        showToast('計画書を削除しました');
    } else if (type === 'user') {
        users = users.filter(u => u.id !== targetId);
        savedCarePlans = savedCarePlans.filter(p => p.userId !== targetId);

        localStorage.setItem('careplan_users', JSON.stringify(users));
        localStorage.setItem('careplan_plans', JSON.stringify(savedCarePlans));

        if (currentUserId === targetId) {
            currentUserId = null;
        }

        renderUserList();
        showToast('利用者を削除しました');
    }
}

// トースト通知（alertの代わり）
function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--text-color);
        color: var(--bg-color);
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 2000;
        animation: fadeIn 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// エラーモーダル（OKを押すまで消えない）
function showErrorModal(message) {
    const modal = document.createElement('div');
    modal.id = 'errorModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 3000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
            text-align: center;
        ">
            <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
            <div style="
                color: var(--text-color);
                font-size: 15px;
                line-height: 1.8;
                white-space: pre-wrap;
                text-align: left;
                margin-bottom: 24px;
                max-height: 60vh;
                overflow-y: auto;
            ">${message}</div>
            <button onclick="closeErrorModal()" style="
                background: var(--primary-color);
                color: white;
                border: none;
                padding: 14px 32px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                width: 100%;
            ">OK</button>
        </div>
    `;

    document.body.appendChild(modal);
}

function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    if (modal) {
        modal.remove();
    }
}

function deleteUser(userId) {
    // iOS対応: カスタム確認モーダルを表示
    showDeleteConfirmModal(userId, 'user');
}

// ========================================
// 計画書保存機能
// ========================================
function saveCarePlan() {
    if (carePlanItems.length === 0) {
        alert('保存する項目がありません');
        return;
    }

    // 既存の計画書を読み込んでいる場合は選択モーダルを表示
    if (currentPlanId) {
        showSaveOptionsModal();
    } else {
        // 新規保存
        doSaveCarePlan(false);
    }
}

function showSaveOptionsModal() {
    const modal = document.createElement('div');
    modal.id = 'saveOptionsModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 16px; color: var(--text-color);">💾 保存方法を選択</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                既存の計画書を読み込んでいます。どのように保存しますか？
            </p>
            
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="btn btn-primary btn-block" onclick="closeSaveOptionsModal(); doSaveCarePlan(true)">
                    🔄 上書き保存
                </button>
                <button class="btn btn-success btn-block" onclick="closeSaveOptionsModal(); doSaveCarePlan(false)">
                    ➕ 新規として保存
                </button>
                <button class="btn btn-secondary btn-block" onclick="closeSaveOptionsModal()">
                    キャンセル
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSaveOptionsModal();
        }
    });
}

function closeSaveOptionsModal() {
    const modal = document.getElementById('saveOptionsModal');
    if (modal) modal.remove();
}

function doSaveCarePlan(overwrite) {
    const now = new Date().toISOString();

    if (overwrite && currentPlanId) {
        // 上書き保存
        const planIndex = savedCarePlans.findIndex(p => p.id === currentPlanId);
        if (planIndex !== -1) {
            savedCarePlans[planIndex].items = [...carePlanItems];
            savedCarePlans[planIndex].assessmentData = { ...assessmentData };
            savedCarePlans[planIndex].updatedAt = now;
            localStorage.setItem('careplan_plans', JSON.stringify(savedCarePlans));
            alert('計画書を上書き保存しました');
            return;
        }
    }

    // 新規保存
    const planId = Date.now().toString();
    const plan = {
        id: planId,
        userId: currentUserId,
        serviceType: selectedServiceType,
        items: [...carePlanItems],
        assessmentData: { ...assessmentData },
        createdAt: now,
        updatedAt: now
    };

    savedCarePlans.push(plan);
    localStorage.setItem('careplan_plans', JSON.stringify(savedCarePlans));
    currentPlanId = planId; // 新規保存後はこの計画書を編集中に
    alert('計画書を新規保存しました');
}

// showScreen関数を更新してuserListScreenに対応
const originalShowScreen = showScreen;
showScreen = function (screenId) {
    originalShowScreen(screenId);

    if (screenId === 'userListScreen') {
        renderUserList();
    }
};

// ========================================
// エクスポート/インポート機能（デバイス間同期用）
// ========================================

// 全データをエクスポート
function exportAllData() {
    const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        data: {
            users: JSON.parse(localStorage.getItem('careplan_users') || '[]'),
            plans: JSON.parse(localStorage.getItem('careplan_plans') || '[]'),
            requiredServices: JSON.parse(localStorage.getItem('requiredServices') || '{}'),
            // 現在の作業中データも含める
            currentSession: {
                assessmentData: assessmentData,
                carePlanItems: carePlanItems,
                selectedServiceType: selectedServiceType,
                currentUserId: currentUserId
            }
        }
    };

    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const fileName = `careplan_backup_${new Date().toISOString().slice(0, 10)}.json`;

    // iOS/Safari対応：ダウンロードリンクを表示するモーダルを使用
    if (navigator.userAgent.match(/iPhone|iPad|iPod|Safari/i) && !navigator.userAgent.match(/Chrome/i)) {
        // iOSやSafariの場合は新しいタブで開く方式
        const url = URL.createObjectURL(blob);
        showExportModal(url, fileName, jsonString);
    } else {
        // 通常のブラウザはダウンロード
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('データをエクスポートしました（ダウンロードフォルダを確認してください）');
    }
}

// エクスポートモーダル（iOS/Safari対応）
function showExportModal(url, fileName, jsonContent) {
    const modal = document.createElement('div');
    modal.id = 'exportModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 3000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
            text-align: center;
        ">
            <h3 style="margin-bottom: 16px; color: var(--text-color);">📤 データのエクスポート</h3>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                ファイル名: <strong>${fileName}</strong>
            </p>
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <a href="${url}" download="${fileName}" 
                   style="
                       background: var(--primary-color);
                       color: white;
                       padding: 14px;
                       border-radius: 8px;
                       text-decoration: none;
                       font-weight: 600;
                   ">💾 ダウンロード</a>
                <button onclick="copyToClipboard('${encodeURIComponent(jsonContent)}'); closeExportModal();" 
                        style="
                            background: var(--success-color, #059669);
                            color: white;
                            border: none;
                            padding: 14px;
                            border-radius: 8px;
                            font-size: 16px;
                            cursor: pointer;
                        ">📋 クリップボードにコピー</button>
                <button onclick="closeExportModal()" 
                        style="
                            background: var(--card-bg);
                            color: var(--text-color);
                            border: 1px solid var(--border-color);
                            padding: 12px;
                            border-radius: 8px;
                            cursor: pointer;
                        ">閉じる</button>
            </div>
            <p style="color: var(--text-secondary); font-size: 12px; margin-top: 16px;">
                💡 ダウンロードできない場合は、「クリップボードにコピー」してメモアプリに貼り付けてください
            </p>
        </div>
    `;

    document.body.appendChild(modal);
}

function closeExportModal() {
    const modal = document.getElementById('exportModal');
    if (modal) modal.remove();
}

function copyToClipboard(encodedContent) {
    const content = decodeURIComponent(encodedContent);
    navigator.clipboard.writeText(content).then(() => {
        showToast('クリップボードにコピーしました');
    }).catch(() => {
        // フォールバック
        const textarea = document.createElement('textarea');
        textarea.value = content;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('クリップボードにコピーしました');
    });
}

// データをインポート
function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);

                // バージョンチェック
                if (!importedData.version || !importedData.data) {
                    throw new Error('無効なファイル形式です');
                }

                // 確認ダイアログ
                const confirmMessage = `以下のデータをインポートします：
・利用者: ${importedData.data.users?.length || 0}人
・計画書: ${importedData.data.plans?.length || 0}件
・必須サービス設定: ${Object.keys(importedData.data.requiredServices || {}).length}カテゴリ

現在のデータに追加されます。続行しますか？`;

                if (!confirm(confirmMessage)) return;

                // データをマージ
                mergeImportedData(importedData.data);

                showToast('インポートが完了しました');

                // 画面を更新
                location.reload();

            } catch (error) {
                alert('インポートに失敗しました: ' + error.message);
            }
        };
        reader.readAsText(file);
    };

    input.click();
}

// インポートデータをマージ
function mergeImportedData(data) {
    // 利用者をマージ（ID重複は上書き）
    if (data.users && data.users.length > 0) {
        const existingUsers = JSON.parse(localStorage.getItem('careplan_users') || '[]');
        const userMap = new Map(existingUsers.map(u => [u.id, u]));
        data.users.forEach(u => userMap.set(u.id, u));
        localStorage.setItem('careplan_users', JSON.stringify([...userMap.values()]));
        users = [...userMap.values()];
    }

    // 計画書をマージ（ID重複は上書き）
    if (data.plans && data.plans.length > 0) {
        const existingPlans = JSON.parse(localStorage.getItem('careplan_plans') || '[]');
        const planMap = new Map(existingPlans.map(p => [p.id, p]));
        data.plans.forEach(p => planMap.set(p.id, p));
        localStorage.setItem('careplan_plans', JSON.stringify([...planMap.values()]));
        savedCarePlans = [...planMap.values()];
    }

    // 必須サービス設定をマージ（上書き）
    if (data.requiredServices && Object.keys(data.requiredServices).length > 0) {
        const existing = JSON.parse(localStorage.getItem('requiredServices') || '{}');
        const merged = { ...existing, ...data.requiredServices };
        localStorage.setItem('requiredServices', JSON.stringify(merged));
    }
}

// エクスポート/インポートモーダルを表示
function showSyncModal() {
    const modal = document.createElement('div');
    modal.id = 'syncModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    `;

    modal.innerHTML = `
        <div style="
            background: var(--bg-color);
            border-radius: 16px;
            max-width: 400px;
            width: 100%;
            padding: 24px;
        ">
            <h2 style="margin-bottom: 16px; color: var(--text-color);">🔄 データ同期</h2>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px;">
                Mac、iPhone、会社PC間でデータを同期できます。
            </p>
            
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="btn btn-primary btn-block" onclick="exportAllData(); closeSyncModal();">
                    📤 エクスポート（データを保存）
                </button>
                <button class="btn btn-success btn-block" onclick="importData(); closeSyncModal();">
                    📥 インポート（データを読み込み）
                </button>
                <button class="btn btn-secondary btn-block" onclick="closeSyncModal()">
                    キャンセル
                </button>
            </div>
            
            <div style="margin-top: 16px; padding: 12px; background: var(--card-bg); border-radius: 8px;">
                <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">
                    💡 エクスポートしたファイルをメール、AirDrop、Googleドライブ等で送信し、他の端末でインポートしてください。
                </p>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSyncModal();
        }
    });
}

function closeSyncModal() {
    const modal = document.getElementById('syncModal');
    if (modal) modal.remove();
}
