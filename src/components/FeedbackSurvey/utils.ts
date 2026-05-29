// Feedback Survey Utils

export type FeedbackSurveyType = 'feedback' | 'memory' | 'post-compact' | 'skill-improvement'

// 用户对调查的回应。运行时始终是这四个字面量之一（见 FeedbackSurveyView
// 的 inputToResponse 0/1/2/3 → dismissed/bad/fine/good）。
export type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'
