// js/supabase-config.js
// ----------------------------------------------------------------------------
// IMPORTANT: Replace these values with your Supabase Project settings.
// You can find them in your Supabase Dashboard -> Project Settings -> API.
// ----------------------------------------------------------------------------

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://etqmvvjdsjzxcclwqwws.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0cW12dmpkc2p6eGNjbHdxd3dzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODk3MzMsImV4cCI6MjA5NzM2NTczM30.wDDMZ9gpIA72Co91O6Pu30y5_hhx0-hnsPYVuFZ2lE4'

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Export Supabase client for use in register.html
window.SUBASupabase = supabase;
