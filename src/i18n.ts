export type PluginLanguage = 'tr' | 'en';
export type TaskFormatMode = 'dotpm' | 'standard';

export const TRANSLATIONS = {
	tr: {
		settingsTitle: 'ODTUClass Senkronizasyon Ayarları',
		languageName: 'Arayüz ve Şablon Dili (Language)',
		languageDesc: 'Eklenti arayüzünün, bildirimlerin ve oluşturulan görev durumlarının dili',
		taskFormatName: 'Görev Formatı Modu (Task Format)',
		taskFormatDesc: 'DotPM eklentisiyle tam uyumlu mod veya standart Obsidian Markdown/Tasks modu',
		taskFormatDotpm: 'DotPM Modu (Proje & Alt Görev Hiyerarşisi)',
		taskFormatStandard: 'Standart Obsidian Modu (Markdown & Tasks)',
		setupWizardBtnName: 'Hızlı Kurulum Sihirbazı',
		setupWizardBtnDesc: 'Yeni kullanıcılar için adım adım GitHub, klasör, dil ve şablon yapılandırma ekranı',
		setupWizardBtnText: 'Kurulum Sihirbazını Aç',
		outputFolderName: 'Görev Çıktı Klasörü (Output Folder)',
		outputFolderDesc: 'Yeni ödev ve haftalık görevlerin oluşturulacağı Vault klasörü (örn: Projects/OdtüClass Tasks/_tasks)',
		templateFolderName: 'Şablon Klasörü (Template Folder)',
		templateFolderDesc: 'Görev şablonlarının bulunduğu klasör (eksikse otomatik oluşturulur)',
		repairTemplatesBtn: 'Şablonları Oluştur / Onar',
		templatesCreatedNotice: 'Varsayılan ODTUClass şablonları kontrol edildi ve oluşturuldu.',
		githubHeader: 'GitHub Senkronizasyonu',
		githubOwnerName: 'GitHub Kullanıcı Adı (Owner)',
		githubOwnerDesc: 'odtuclass-sync deponuzun bağlı olduğu GitHub hesabı',
		githubRepoName: 'GitHub Depo Adı (Repository)',
		githubRepoDesc: 'Senkronizasyon verilerinin tutulduğu depo adı (örn: odtuclass-sync)',
		githubTokenName: 'GitHub Token (Fine-grained PAT)',
		githubTokenDesc: 'Deponuza okuma (ve filtre kaydı için yazma) izni olan erişim anahtarı',
		syncNowName: 'GitHub\'dan Şimdi Senkronize Et',
		syncNowDesc: 'Yapılandır된 GitHub deposundan ödevleri, bölümleri ve slaytları hemen çeker',
		syncNowBtn: 'Sync ODTUClass',
		ntfyHeader: '🔔 Bildirim & Akademik Dönem Filtreleri (ntfy / Bot)',
		ntfyDesc: 'Hangi ODTÜClass etkinliklerinin telefonunuza (ntfy) bildirim olarak geleceğini seçin. (Görev dışı duyurular ve yoklamalar hiçbir zaman DotPM görevlerinize karışmaz.)',
		ntfyLoadBtn: 'GitHub\'dan Filtreleri Yükle',
		ntfySaveBtn: 'Filtreleri GitHub\'a Kaydet',
		ntfySavedNotice: 'Bildirim ve dönem ayarları GitHub (.odtuclass/config.json) üzerine kaydedildi!',
		ntfySaveErrorNotice: 'GitHub üzerine kaydedilemedi (Token yazma izni veya bağlantı kontrol edin). Ayarlar yerel olarak saklandı.',
		termSettingName: 'Akademik Dönem Algılama',
		termSettingDesc: 'Otomatik modda bulunduğunuz aya göre Güz (Fall), Bahar (Spring) veya Yaz (Summer) dönemi otomatik seçilir',
		termAuto: 'Otomatik Algıla (Önerilen)',
		cat_assignment: 'Ödevler (Assignments, Pearson, Turnitin, VPL)',
		cat_quiz: 'Quiz ve Sınavlar (Quizzes)',
		cat_recitation: 'Recitation ve Çalışma Soruları (PDF / Worksheet)',
		cat_lab: 'Laboratuvar Görevleri ve Föyleri (Labs)',
		cat_section: 'Haftalık Ders İçeriği Güncellemeleri (Sections)',
		cat_announcement: 'Ders Duyuruları ve Takvim Etkinlikleri (Forum & Calendar)',
		cat_survey: 'Anket ve Seçim Formları (Choice / Feedback)',
		cat_attendance: 'Yoklama Bildirimleri (Attendance)',
		slidesHeader: '📊 Ders Slaytları (Course Slides Sync)',
		autoFormatSlidesName: 'Standart slayt dosya isimlendirmesi (Örn: "2026 Week 1a.pdf")',
		autoFormatSlidesDesc: 'Açık olduğunda ODTUClass üzerindeki "CENG111-2026--Week1a.pdf" gibi ham isimler "2026 Week 1a.pdf" formatına dönüştürülür.',
		scanSlidesName: 'Slaytı Bulunan Dersleri GitHub\'dan Tara',
		scanSlidesDesc: 'GitHub deponuzdaki slayt manifestosunu kontrol ederek slayt tespit edilen dersleri aşağıdaki listeye ekler.',
		scanSlidesBtn: 'Dersleri Algıla',
		addSlideCourseName: 'Manuel Ders Slayt Klasörü Ekle',
		addSlideCourseDesc: 'Yeni bir ders kodu (örn: MATH119) ve hedef klasör (örn: Courses/MATH119/Slides) ekleyin',
		addBtn: 'Ekle',
		historyHeader: '🕒 Senkronizasyon Geçmişi (Sync History)',
		historySettingName: 'Çekme ve Görev Geçmişi',
		historySettingDesc: 'Her senkronizasyonda hangi ders/hafta altına hangi ödevlerin, alt görevlerin veya slaytların eklendiğini gösterir.',
		historyRebuildBtn: 'Vault\'tan Geçmişi Yenile',
		historyClearBtn: 'Geçmişi Temizle',
		historyEmpty: 'Henüz kaydedilmiş bir senkronizasyon geçmişi yok. "Sync ODTUClass" veya "Vault\'tan Geçmişi Yenile" butonuna tıklayabilirsiniz.',
		statusTodo: 'Yapılacak',
		statusInProgress: 'Devam Ediyor',
		statusDone: 'Tamamlandı',
		labelStart: 'Başlangıç',
		labelDue: 'Teslim',
		labelClose: 'Kapanış',
		labelStatus: 'Durum',
	},
	en: {
		settingsTitle: 'ODTUClass Sync Settings',
		languageName: 'Interface & Template Language',
		languageDesc: 'Language used for plugin settings, notices, and task status labels',
		taskFormatName: 'Task Format Mode',
		taskFormatDesc: 'Choose DotPM hierarchy mode or standard Obsidian Markdown/Tasks mode',
		taskFormatDotpm: 'DotPM Mode (Project & Subtask Hierarchy)',
		taskFormatStandard: 'Standard Obsidian Mode (Markdown & Tasks)',
		setupWizardBtnName: 'Quick Setup Wizard',
		setupWizardBtnDesc: 'Step-by-step configuration wizard for GitHub, folders, language, and templates',
		setupWizardBtnText: 'Open Setup Wizard',
		outputFolderName: 'Output Folder',
		outputFolderDesc: 'Vault folder where new assignments and weekly tasks will be created',
		templateFolderName: 'Template Folder',
		templateFolderDesc: 'Vault folder where task templates are stored (auto-created if missing)',
		repairTemplatesBtn: 'Create / Repair Templates',
		templatesCreatedNotice: 'Default ODTUClass templates verified and created.',
		githubHeader: 'GitHub Sync',
		githubOwnerName: 'GitHub Owner',
		githubOwnerDesc: 'GitHub username or organization hosting your odtuclass-sync repository',
		githubRepoName: 'GitHub Repository',
		githubRepoDesc: 'Repository name (e.g. odtuclass-sync)',
		githubTokenName: 'GitHub Token (Fine-grained PAT)',
		githubTokenDesc: 'Personal Access Token with Contents Read (and Write for saving config) access',
		syncNowName: 'Sync from GitHub',
		syncNowDesc: 'Manually trigger a sync of assignments, sections, and slides from GitHub',
		syncNowBtn: 'Sync ODTUClass',
		ntfyHeader: '🔔 Notification & Academic Term Filters (ntfy / Bot)',
		ntfyDesc: 'Choose which ODTUClass categories send push notifications to ntfy. (Non-task announcements and attendance never clutter your Obsidian tasks.)',
		ntfyLoadBtn: 'Load Filters from GitHub',
		ntfySaveBtn: 'Save Filters to GitHub',
		ntfySavedNotice: 'Notification and term settings saved to GitHub (.odtuclass/config.json)!',
		ntfySaveErrorNotice: 'Could not push config to GitHub (check Token write permission). Saved locally.',
		termSettingName: 'Academic Term Detection',
		termSettingDesc: 'In Auto mode, Fall, Spring, or Summer term is detected automatically from the current date',
		termAuto: 'Auto Detect (Recommended)',
		cat_assignment: 'Assignments (Moodle Assign, Pearson, Turnitin, VPL)',
		cat_quiz: 'Quizzes & Exams',
		cat_recitation: 'Recitations & Worksheets (PDF)',
		cat_lab: 'Laboratory Tasks & Manuals',
		cat_section: 'Weekly Course Section Updates',
		cat_announcement: 'Course Announcements & Calendar Events (Forum & Calendar)',
		cat_survey: 'Surveys & Polls (Choice / Feedback)',
		cat_attendance: 'Attendance Notices',
		slidesHeader: '📊 Course Slides Sync',
		autoFormatSlidesName: 'Standardize slide filenames (e.g. "2026 Week 1a.pdf")',
		autoFormatSlidesDesc: 'Automatically formats raw filenames like "CENG111-2026--Week1a.pdf" into "2026 Week 1a.pdf".',
		scanSlidesName: 'Scan Courses with Slides from GitHub',
		scanSlidesDesc: 'Reads the slide manifest from your GitHub repo and adds detected courses below.',
		scanSlidesBtn: 'Detect Courses',
		addSlideCourseName: 'Add Course Slide Folder Manually',
		addSlideCourseDesc: 'Add a course code (e.g. MATH119) and target Vault folder (e.g. Courses/MATH119/Slides)',
		addBtn: 'Add',
		historyHeader: '🕒 Sync History',
		historySettingName: 'Sync & Task History',
		historySettingDesc: 'Shows which assignments, subtasks, or slides were added/updated in each sync run.',
		historyRebuildBtn: 'Rebuild History from Vault',
		historyClearBtn: 'Clear History',
		historyEmpty: 'No sync history recorded yet. Click "Sync ODTUClass" or "Rebuild History from Vault".',
		statusTodo: 'To Do',
		statusInProgress: 'In Progress',
		statusDone: 'Completed',
		labelStart: 'Opened',
		labelDue: 'Due',
		labelClose: 'Closes',
		labelStatus: 'Status',
	}
};

export function t(lang: PluginLanguage | undefined, key: keyof typeof TRANSLATIONS['tr']): string {
	const l: PluginLanguage = lang === 'en' ? 'en' : 'tr';
	return TRANSLATIONS[l][key] || TRANSLATIONS.tr[key] || String(key);
}

export function getDefaultTemplateContent(
	templateName: 'Assignment' | 'Quiz' | 'Interactive' | 'Section' | 'Subtask',
	lang: PluginLanguage = 'tr',
	taskFormat: TaskFormatMode = 'dotpm'
): string {
	const isEn = lang === 'en';
	const startLbl = isEn ? 'Opened' : 'Başlangıç';
	const dueLbl = isEn ? 'Due' : 'Teslim';
	const closeLbl = isEn ? 'Closes' : 'Kapanış';
	const statusLbl = isEn ? 'Status' : 'Durum';
	const todoVal = isEn ? 'To Do' : 'Yapılacak';

	if (templateName === 'Section') {
		const fm =
			taskFormat === 'dotpm'
				? `---
pm-task: true
projectId: "[[OdtüClass Tasks|OdtüClass Tasks]]"
parentId: "[[{{parentFileName}}|{{parentTitle}}]]"
id: "{{id}}"
title: "{{cleanTitle}}"
type: "subtask"
status: "todo"
priority: "medium"
due: "{{weekEnd}}"
weekStart: "{{weekStart}}"
weekEnd: "{{weekEnd}}"
subtaskIds: []
tags:
  - odtuclass
  - section
  - coursework
odtuclass-url: "{{url}}"
odtuclass-course-id: "{{courseId}}"
odtuclass-course: "{{courseName}}"
odtuclass-section-id: "{{sectionId}}"
odtuclass-hash: "{{contentHash}}"
---`
				: `---
id: "{{id}}"
title: "{{cleanTitle}}"
type: "section"
status: "todo"
due: "{{weekEnd}}"
weekStart: "{{weekStart}}"
weekEnd: "{{weekEnd}}"
tags:
  - odtuclass
  - section
odtuclass-url: "{{url}}"
odtuclass-course-id: "{{courseId}}"
odtuclass-course: "{{courseName}}"
odtuclass-section-id: "{{sectionId}}"
odtuclass-hash: "{{contentHash}}"
---`;

		return `${fm}

# {{cleanTitle}}

**Course:** [[{{parentFileName}}|{{parentTitle}}]]  
**Week Range:** {{weekStart}} — {{weekEnd}}  
**ODTUClass Section:** [View on ODTUClass]({{url}})  

## Coursework & Details

<!-- ODTUCLASS:BEGIN -->
{{content}}
<!-- ODTUCLASS:END -->

## Subtasks

<!-- ODTUCLASS:SUBTASKS:BEGIN -->
<!-- ODTUCLASS:SUBTASKS:END -->

## My Notes & Workspace

- [ ] 
`;
	}

	if (templateName === 'Subtask') {
		const fm =
			taskFormat === 'dotpm'
				? `---
pm-task: true
projectId: "[[OdtüClass Tasks|OdtüClass Tasks]]"
parentId: "[[{{parentFileName}}|{{parentTitle}}]]"
id: "{{id}}"
title: "{{title}}"
type: "subtask"
status: "todo"
priority: "medium"
due: "{{dueDate}}"
subtaskIds: []
tags:
  - odtuclass
  - coursework
  - practice
---`
				: `---
id: "{{id}}"
title: "{{title}}"
type: "subtask"
status: "todo"
due: "{{dueDate}}"
tags:
  - odtuclass
  - practice
---`;

		return `${fm}

Parent: [[{{parentFileName}}|{{parentTitle}}]]

## Suggested Problems (Ch. {{chapter}})

{{problemsList}}

## My Notes & Workspace

- [ ] 
`;
	}

	const modLabel =
		templateName === 'Quiz'
			? 'Quiz'
			: templateName === 'Interactive'
				? 'Interactive Activity'
				: 'Assignment';

	const fm =
		taskFormat === 'dotpm'
			? `---
pm-task: true
projectId: "[[OdtüClass Tasks|OdtüClass Tasks]]"
parentId: "[[{{parentFileName}}|{{parentTitle}}]]"
id: "{{id}}"
title: "{{cleanTitle}}"
type: "subtask"
status: "todo"
priority: "medium"
start: "{{openDate}}"
due: "{{dueDate}}"
tags:
  - odtuclass
  - "{{moduleType}}"
odtuclass-url: "{{url}}"
odtuclass-course-id: "{{courseId}}"
odtuclass-course: "{{courseName}}"
odtuclass-module-id: "{{moduleId}}"
odtuclass-module-type: "{{moduleType}}"
opened: "{{openDate}}"
---`
			: `---
id: "{{id}}"
title: "{{cleanTitle}}"
type: "assignment"
status: "todo"
start: "{{openDate}}"
due: "{{dueDate}}"
tags:
  - odtuclass
  - "{{moduleType}}"
odtuclass-url: "{{url}}"
odtuclass-course-id: "{{courseId}}"
odtuclass-course: "{{courseName}}"
odtuclass-module-id: "{{moduleId}}"
odtuclass-module-type: "{{moduleType}}"
opened: "{{openDate}}"
---`;

	const standardTaskLine =
		taskFormat === 'standard'
			? `\n- [ ] {{cleanTitle}} 📅 {{dueDate}}\n`
			: '';

	return `${fm}

# {{cleanTitle}}

**Course:** [[{{parentFileName}}|{{parentTitle}}]]  
**Module Type:** ${modLabel}  
**ODTUClass:** [View on ODTUClass]({{url}})  
${standardTaskLine}
- **${startLbl}:** {{openDate}} {{openTime}}
- **${dueLbl}:** {{dueDate}} {{dueTime}}
- **${closeLbl}:** {{closeDate}} {{closeTime}}
- **${statusLbl}:** ${todoVal}

## Description
`;
}
