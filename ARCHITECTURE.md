# Sistem Mimarisi (Architecture Overview)

Bu doküman, Gemini destekli Otonom WhatsApp Ajanı'nın iç çalışma prensiplerini, modüler yapısını ve veri kalıcılığı (data persistence) stratejilerini detaylandırmaktadır. Proje, Node.js ekosisteminde olay güdümlü (event-driven) bir mimari ile tasarlanmıştır.

## 🏗️ Çekirdek Akış ve Modüller

Sistem, ayrık sorumluluk prensibine (Separation of Concerns) sıkı sıkıya bağlı 6 ana modülden oluşmaktadır:

```mermaid
graph TD
    subgraph "Dış Dünya (External Interfaces)"
        WA[WhatsApp Web API]
        CLI[Gemini CLI Process]
    end

    subgraph "Core İş Katmanı (Business Logic)"
        M[main.js<br>Gateway]
        CP[commandParser.js<br>Parser]
        MM[missionManager.js<br>State Manager]
        SCH[scheduler.js<br>Job Runner]
        CE[conversationEngine.js<br>Prompt & Logic]
        GC[geminiClient.js<br>Process Bridge]
    end

    WA <-->|Mesajlar| M
    M -->|Ham Komut| CP
    CP -->|Parsed DTO| MM
    MM <-->|Zamanlama İsteği| SCH
    MM <-->|Bağlam & Geçmiş| CE
    CE <-->|LLM Formatı| GC
    GC -.->|StdIn/StdOut| CLI

    classDef core fill:#0f3460,stroke:#e94560,color:#fff
    classDef ext fill:#1a1a2e,stroke:#16213e,color:#fff
    class M,CP,MM,SCH,CE,GC core
    class WA,CLI ext
```

### 1. Gateway (`main.js`)
Sistemin giriş noktasıdır. `whatsapp-web.js` istemcisini ayağa kaldırır, yetkilendirmeyi (QR Auth) yönetir ve gelen tüm trafiği filtreleyip `commandParser` ve `missionManager` modüllerine yönlendirir.

### 2. State Manager (`missionManager.js`)
Sistemin beynidir. Otonom görevlerin durumlarını (Active, Completed, Failed) izler, bellekteki verileri senkronize eder ve disk tabanlı kalıcılığı (`active_missions.json`) sağlar.
- **Message Pooling:** Gelen peş peşe mesajları yakalayan ve yığınlaştıran (batching) özel bir zamanlayıcı yönetir.

### 3. Zeka Motoru (`conversationEngine.js`)
LLM ile uygulama arasındaki köprüdür. Gelişmiş prompt mühendisliği (Prompt Engineering) tekniklerini barındırır. Otonom kararların alınabilmesi için LLM'e gerekli sınırları, zaman bilgisini ve çıktı kontratlarını zorlar.

---

## ⏳ Mesaj Havuzu (Message Pooling) Süreci

Karşı tarafın peş peşe gönderdiği (örn: "Tamam", "Yarın hallederim", "Saat 10 gibi") mesajlara tek tek saçma cevaplar vermemek ve API maliyetlerini düşürmek için pooling mekanizması kullanılır.

```mermaid
stateDiagram-v2
    [*] --> Idle
    
    Idle --> MessageReceived : Yeni Mesaj Geldi
    MessageReceived --> Pooling : Kuyruğa Ekle (messageQueue.push)
    
    Pooling --> Pooling : 15 Sn İçinde Yeni Mesaj (Drain Reset)
    Pooling --> Processing : 15 Sn Sessizlik (Timeout Trigger)
    
    Processing --> LLM : Kuyruğu Birleştir (join('\n'))
    LLM --> Idle : Tek, Bütünsel Yanıt Gönder
```

---

## 🧠 Katmanlı Prompt Mimarisi

`conversationEngine.js` içindeki `buildSystemPrompt` metodu, LLM'in kimliğini ve sınırlarını 5 katmanlı bir mimariyle oluşturur. Bu, LLM'in halüsinasyon görmesini (hallucination) engeller.

1. **Kimlik Katmanı:** Botun adı, kimi temsil ettiği.
2. **Görev Katmanı:** O an çözmeye çalıştığı problem (`taskDescription`).
3. **Davranış Katmanı:** Üslup kuralları, tekrara düşmeme emirleri.
4. **Farkındalık Katmanı:** Gelen mesajlara dinamik enjekte edilen `[SAAT: ...]` etiketinin nasıl yorumlanacağı.
5. **Çıktı Kontratı Katmanı:** Kesin JSON format zorunluluğu.

### Çıktı Kontratı (JSON Schema)

LLM'in verdiği her karar uygulamaya aşağıdaki katı JSON formatında dönmek zorundadır:

```json
{
  "reply": "Karşı tarafa gönderilecek metin",
  "status": "active | completed | failed",
  "memberStatus": {
    "Ali": "Dosyaları gönderdi",
    "Ayşe": "Hafta sonu dönüş yapacak"
  }
}
```

> [!WARNING]
> LLM bazen JSON formatını bozabilir veya içine Markdown bloğu ekleyebilir. `_processResponse` metodu, agresif Regex ve fallback mekanizmalarıyla bu string'i temizleyip parse edilebilir hale getirir.

---

## 💾 Veri Modeli ve Kalıcılık (Data Persistence)

Sunucu kapanmaları, elektrik kesintileri veya manuel yeniden başlatmalara karşı veri kaybını önlemek için aktif görevler anlık olarak dosyaya yazılır (`data/active_missions.json`).

```mermaid
erDiagram
    MISSION {
        string id PK "Benzersiz Görev ID"
        string targetNumber "Karşı tarafın WA numarası"
        string taskDescription "Asıl Görev Metni"
        string status "active, completed, failed"
        int messageCount "Toplam gönderilen mesaj"
        int retryCount "Otonom dürtme sayısı"
        array conversationHistory "LLM Konuşma Bağlamı"
        object options "tone, until, vb."
    }
```

`scheduler.js`, uygulama ilk açıldığında bu JSON dosyasını tarar. Eğer görev `active` ise ve bekleme süresi varsa, zamanlayıcıları (setTimeout) bellek üzerinde yeniden kurar. Böylece ajan, haftalar süren görevleri bile hafızası silinmeden yürütebilir.
