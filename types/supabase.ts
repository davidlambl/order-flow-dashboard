export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      chat_histories: {
        Row: {
          deleted_at: string | null
          messages: Json | null
          ticker: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          deleted_at?: string | null
          messages?: Json | null
          ticker: string
          updated_at?: string | null
          user_id?: string
        }
        Update: {
          deleted_at?: string | null
          messages?: Json | null
          ticker?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      earnings_cache: {
        Row: {
          data: Json
          fetched_at: string
          next_report_date: string | null
          ticker: string
        }
        Insert: {
          data: Json
          fetched_at?: string
          next_report_date?: string | null
          ticker: string
        }
        Update: {
          data?: Json
          fetched_at?: string
          next_report_date?: string | null
          ticker?: string
        }
        Relationships: []
      }
      flow_history: {
        Row: {
          call_premium: number | null
          call_volume: number
          created_at: string | null
          cum_premium: number
          date: string
          id: number
          net_premium: number
          provider: string | null
          put_premium: number | null
          put_volume: number
          spot_price: number | null
          ticker: string
        }
        Insert: {
          call_premium?: number | null
          call_volume: number
          created_at?: string | null
          cum_premium: number
          date: string
          id?: never
          net_premium: number
          provider?: string | null
          put_premium?: number | null
          put_volume: number
          spot_price?: number | null
          ticker: string
        }
        Update: {
          call_premium?: number | null
          call_volume?: number
          created_at?: string | null
          cum_premium?: number
          date?: string
          id?: never
          net_premium?: number
          provider?: string | null
          put_premium?: number | null
          put_volume?: number
          spot_price?: number | null
          ticker?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          cost_basis: number | null
          deleted_at: string | null
          shares: number | null
          ticker: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cost_basis?: number | null
          deleted_at?: string | null
          shares?: number | null
          ticker: string
          updated_at?: string | null
          user_id?: string
        }
        Update: {
          cost_basis?: number | null
          deleted_at?: string | null
          shares?: number | null
          ticker?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      preferences: {
        Row: {
          deleted_at: string | null
          key: string
          updated_at: string | null
          user_id: string
          value: Json | null
        }
        Insert: {
          deleted_at?: string | null
          key: string
          updated_at?: string | null
          user_id?: string
          value?: Json | null
        }
        Update: {
          deleted_at?: string | null
          key?: string
          updated_at?: string | null
          user_id?: string
          value?: Json | null
        }
        Relationships: []
      }
      revoked_tokens: {
        Row: {
          jti: string
          reason: string | null
          revoked_at: string
          sub: string | null
        }
        Insert: {
          jti: string
          reason?: string | null
          revoked_at?: string
          sub?: string | null
        }
        Update: {
          jti?: string
          reason?: string | null
          revoked_at?: string
          sub?: string | null
        }
        Relationships: []
      }
      usage_log: {
        Row: {
          created_at: string
          id: number
          key_source: string
          model: string | null
          provider: string
          request_id: string | null
          stream: boolean
          sub: string | null
          tier: string | null
        }
        Insert: {
          created_at?: string
          id?: never
          key_source: string
          model?: string | null
          provider: string
          request_id?: string | null
          stream?: boolean
          sub?: string | null
          tier?: string | null
        }
        Update: {
          created_at?: string
          id?: never
          key_source?: string
          model?: string | null
          provider?: string
          request_id?: string | null
          stream?: boolean
          sub?: string | null
          tier?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
