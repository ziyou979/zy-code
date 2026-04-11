// Feedback Survey Utils

export type FeedbackSurveyType = 'feedback' | 'memory' | 'post-compact' | 'skill-improvement'

export interface FeedbackSurveyResponse {
  surveyType: FeedbackSurveyType
  rating?: number
  feedback?: string
  timestamp: string
}
