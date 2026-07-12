import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import db from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Helper to hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Helper to generate a random 8-character ID
function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

// 1. Create a new event
app.post('/api/events', (req, res) => {
  try {
    const { name, candidateDates, capacity, location, fee, password } = req.body;

    if (!name || !candidateDates || !Array.isArray(candidateDates) || candidateDates.length === 0 || !password) {
      return res.status(400).json({ error: 'イベント名、日程候補、パスワードは必須です。' });
    }

    const id = generateId();
    const candidateDatesJson = JSON.stringify(candidateDates);
    const hashedPassword = hashPassword(password);

    const insertStmt = db.prepare(`
      INSERT INTO events (id, name, candidate_dates, capacity, location, fee, admin_password)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      id,
      name,
      candidateDatesJson,
      capacity ? parseInt(capacity, 10) : null,
      location || '',
      fee ? parseInt(fee, 10) : 0,
      hashedPassword
    );

    res.status(201).json({ success: true, eventId: id });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'イベントの作成に失敗しました。' });
  }
});

// 2. Get event details (public info)
app.get('/api/events/:eventId', (req, res) => {
  try {
    const { eventId } = req.params;
    const stmt = db.prepare('SELECT id, name, candidate_dates, capacity, location, fee FROM events WHERE id = ?');
    const event = stmt.get(eventId);

    if (!event) {
      return res.status(404).json({ error: 'イベントが見つかりません。' });
    }

    // Parse candidate dates
    event.candidate_dates = JSON.parse(event.candidate_dates);

    // Get current attending count
    const countStmt = db.prepare("SELECT COUNT(*) as count FROM participants WHERE event_id = ? AND status = 'attending'");
    const result = countStmt.get(eventId);
    event.current_attendees = result ? result.count : 0;

    res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'イベント情報の取得に失敗しました。' });
  }
});

// 3. AI Chat & RSVP Endpoint
app.post('/api/rsvp/:eventId/chat', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { messages } = req.body; // Array of { role, content }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'チャット履歴がありません。' });
    }

    // Fetch event details
    const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    const event = eventStmt.get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'イベントが見つかりません。' });
    }

    const candidateDates = JSON.parse(event.candidate_dates).join(', ');

    // System prompt instructing the AI
    const systemPrompt = `あなたは飲み会調整AIアシスタントです。
幹事が登録したイベント「${event.name}」の参加受付を担当しています。

【イベント情報】
- 場所: ${event.location || '未定'}
- 会費: ${event.fee ? event.fee + '円' : '未定'}
- 定員: ${event.capacity ? event.capacity + '人' : '制限なし'}
- 日程候補: ${candidateDates}

参加希望者とチャットをしながら、以下の情報を必ず順番にヒアリングしてください：
1. 参加者の氏名（本名または分かりやすいニックネーム）
2. 参加希望日（日程候補「${candidateDates}」の中から都合が良い日をすべて、または特定の日を1つ選んでもらいます。もし日程候補がどれも合わない場合は、 status を "absent" にしてください）
3. 要望・アレルギー・その他コメント（特にない場合は「なし」で構いません）

【対話のガイドライン】
- 日本語で、丁寧かつフレンドリーに話してください。
- 参加者が「参加します」または「いけません（不参加）」を明確に表明するまで質問を続けてください。
- すべての情報をヒアリングし終えたら、「この内容で登録してもよろしいですか？」と登録内容（名前、希望日、アレルギー・要望など）を要約して確認を取ってください。
- ユーザーから「はい」「登録してください」などの合意が得られた場合のみ、**必ず応答の最後**に以下のJSONフォーマットで登録データを出力してください。

[REGISTRATION_DATA]
{
  "name": "抽出した参加者の氏名",
  "selected_date": "選択された日程（不参加の場合は「なし」や「不参加」）",
  "status": "attending" または "absent" または "undecided",
  "notes": "要望やアレルギーなどの特記事項。ない場合は空文字"
}
[/REGISTRATION_DATA]

重要：
- 登録完了の確認（合意）が得られるまでは、絶対に上記の \`[REGISTRATION_DATA]\` タグとJSONコードを出力しないでください。
- 一度にすべての質問をするのではなく、自然な会話のキャッチボールを行ってください。`;

    // Construct request payload for local Ollama
    // keep_alive → モデルをメモリに30分保持してコールドスタートを防止
    // ※ think フラグは Ollama v0.9+ 以降のみ対応。現バージョンでは使用しない
    const ollamaPayload = {
      model: 'gemma4',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      stream: false,
      keep_alive: '30m',
      options: {
        temperature: 0.7  // 一貫性のある日本語応答のため適切な値に設定
      }
    };

    // Call local Ollama
    const ollamaResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(ollamaPayload)
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama API returned status ${ollamaResponse.status}`);
    }

    const data = await ollamaResponse.json();

    // think:false でも稀に content が空で thinking だけ返る場合があるため
    // content → thinking → フォールバックメッセージの順で取得する
    const rawContent = data.message?.content || data.message?.thinking || '';
    const assistantReply = rawContent.trim() ||
      '申し訳ありません、応答の生成に失敗しました。もう一度お試しください。';

    // Check if assistant reply contains the registration JSON payload
    const regRegex = /\[REGISTRATION_DATA\]([\s\S]*?)\[\/REGISTRATION_DATA\]/;
    const match = assistantReply.match(regRegex);

    if (match) {
      try {
        const jsonStr = match[1].trim();
        const regData = JSON.parse(jsonStr);

        // --- 定員チェック＋INSERT をトランザクションで原子的に実行 ---
        // 複数人が同時に登録確定しても定員オーバーが起きないよう排他制御する
        const insertWithCapacityCheck = db.transaction(() => {
          // 定員が設定されており、かつ参加ステータスの場合のみチェック
          if (event.capacity && regData.status === 'attending') {
            const countRow = db.prepare(
              "SELECT COUNT(*) AS cnt FROM participants WHERE event_id = ? AND status = 'attending'"
            ).get(eventId);
            if (countRow.cnt >= event.capacity) {
              // トランザクション内で例外を投げるとロールバックされる
              throw Object.assign(new Error('CAPACITY_FULL'), { capacityFull: true });
            }
          }

          db.prepare(`
            INSERT INTO participants (event_id, name, status, selected_date, notes, chat_history)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            eventId,
            regData.name || 'ゲスト',
            regData.status || 'attending',
            regData.selected_date || '',
            regData.notes || '',
            JSON.stringify(messages.concat({ role: 'assistant', content: assistantReply }))
          );
        });

        try {
          insertWithCapacityCheck();
        } catch (txErr) {
          if (txErr.capacityFull) {
            // 定員オーバー → フロントエンドに通知（登録は完了させない）
            const cleanedReply = assistantReply.replace(regRegex, '').trim();
            return res.json({
              reply: `申し訳ありません、定員（${event.capacity}人）に達したため、これ以上の参加登録を受け付けることができません。幹事にご連絡ください。`,
              registrationComplete: false,
              capacityFull: true
            });
          }
          throw txErr;
        }

        // Strip the JSON block from the reply sent back to frontend
        const cleanedReply = assistantReply.replace(regRegex, '').trim();

        return res.json({
          reply: cleanedReply || '参加登録が完了しました！ありがとうございます。',
          registrationComplete: true,
          registration: regData
        });
      } catch (jsonErr) {
        console.error('Failed to parse registration JSON:', jsonErr, match[1]);
        // Return normal reply if parsing fails
      }
    }

    // Return normal chat response
    res.json({
      reply: assistantReply,
      registrationComplete: false
    });
  } catch (error) {
    console.error('Error in chat RSVP:', error);
    res.status(500).json({ error: 'AIチャットの通信に失敗しました。Ollamaが起動しているか確認してください。' });
  }
});

// 4. Admin Login Verification
app.post('/api/admin/:eventId/login', (req, res) => {
  try {
    const { eventId } = req.params;
    const { password } = req.body;

    const stmt = db.prepare('SELECT admin_password FROM events WHERE id = ?');
    const event = stmt.get(eventId);

    if (!event) {
      return res.status(404).json({ error: 'イベントが見つかりません。' });
    }

    const hashedPassword = hashPassword(password);
    if (event.admin_password === hashedPassword) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'パスワードが間違っています。' });
    }
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: '認証処理に失敗しました。' });
  }
});

// 5. Admin Dashboard Data
app.get('/api/admin/:eventId/dashboard', (req, res) => {
  try {
    const { eventId } = req.params;
    const adminPassword = req.headers['x-admin-password'];

    if (!adminPassword) {
      return res.status(401).json({ error: '認証パスワードが必要です。' });
    }

    const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    const event = eventStmt.get(eventId);

    if (!event) {
      return res.status(404).json({ error: 'イベントが見つかりません。' });
    }

    const hashedInput = hashPassword(adminPassword);
    if (event.admin_password !== hashedInput) {
      return res.status(401).json({ error: 'パスワードが無効です。' });
    }

    event.candidate_dates = JSON.parse(event.candidate_dates);

    // Fetch participants
    const participantsStmt = db.prepare('SELECT id, name, status, selected_date, notes, created_at FROM participants WHERE event_id = ? ORDER BY created_at DESC');
    const participants = participantsStmt.all(eventId);

    // Compute stats
    const total = participants.length;
    const attending = participants.filter(p => p.status === 'attending').length;
    const absent = participants.filter(p => p.status === 'absent').length;
    const undecided = participants.filter(p => p.status === 'undecided').length;

    // Date preferences distribution
    const dateDistribution = {};
    event.candidate_dates.forEach(date => {
      dateDistribution[date] = 0;
    });

    participants.forEach(p => {
      if (p.status === 'attending' && p.selected_date) {
        // A participant might select multiple dates separated by comma or just a specific date.
        // We match candidate dates in the selected_date text
        event.candidate_dates.forEach(date => {
          if (p.selected_date.includes(date)) {
            dateDistribution[date]++;
          }
        });
      }
    });

    res.json({
      event: {
        id: event.id,
        name: event.name,
        candidate_dates: event.candidate_dates,
        capacity: event.capacity,
        location: event.location,
        fee: event.fee
      },
      stats: {
        total,
        attending,
        absent,
        undecided,
        dateDistribution
      },
      participants
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'ダッシュボードデータの取得に失敗しました。' });
  }
});

app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  // --- Ollama ウォームアップ呼び出し ---
  // サーバー起動直後にモデルをメモリに展開しておき、
  // 最初のユーザーリクエストでのコールドスタート遅延を排除する
  console.log('Warming up Ollama model (gemma4)...');
  try {
    const warmupRes = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma4',
        messages: [{ role: 'user', content: 'こんにちは' }],
        stream: false,
        keep_alive: '30m'
      })
    });
    if (warmupRes.ok) {
      console.log('Ollama warmup complete. Model is ready.');
    } else {
      console.warn(`Ollama warmup returned status ${warmupRes.status}. First request may be slow.`);
    }
  } catch (e) {
    console.warn('Ollama warmup failed (is Ollama running?):', e.message);
  }
});
