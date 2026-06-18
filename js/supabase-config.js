// js/supabase-config.js
// ----------------------------------------------------------------------------
// IMPORTANT: Replace these values with your Supabase Project settings.
// You can find them in your Supabase Dashboard -> Project Settings -> API.
// ----------------------------------------------------------------------------

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'YOUR_SUPABASE_URL'
const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY'

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Export Supabase client for use in register.html
window.SUBASupabase = supabase;
