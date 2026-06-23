import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

let wss = null;
const clients = new Map(); // Map of socket -> { userId, role, email }

export function initializeWebSocket(server) {
  wss = new WebSocketServer({ server });
  
  console.log("🔌 WebSocket Server initialized on the shared HTTP port.");

  wss.on('connection', (ws, req) => {
    console.log("🔌 WebSocket client connected.");
    
    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        
        // Handle auth/handshake to bind socket to user ID
        if (payload.type === 'auth') {
          const token = payload.token;
          if (token) {
            jwt.verify(token, process.env.JWT_SECRET || 'change-me-to-a-strong-jwt-secret', (err, decoded) => {
              if (err) {
                ws.send(JSON.stringify({ type: 'error', message: 'WebSocket Authentication failed.' }));
              } else {
                clients.set(ws, {
                  userId: decoded.userId,
                  role: decoded.role,
                  email: decoded.email
                });
                console.log(`🔌 WebSocket client authenticated: User ${decoded.email} (${decoded.role})`);
                ws.send(JSON.stringify({ type: 'auth_success', message: 'Authenticated successfully.' }));
              }
            });
          }
        }
        
        // Handle customer support message/ticket submission in real-time
        if (payload.type === 'support_message') {
          const clientInfo = clients.get(ws);
          const userEmail = clientInfo ? clientInfo.email : 'Anonymous';
          const userId = clientInfo ? clientInfo.userId : null;
          
          console.log(`💬 Real-time support message from ${userEmail}: ${payload.message}`);
          
          // Broadcast to all admin connections in real-time
          broadcastToAdmins({
            type: 'admin_notification',
            category: 'support_ticket',
            title: `New Support Ticket from ${userEmail}`,
            message: payload.message,
            userId: userId,
            email: userEmail,
            timestamp: new Date().toISOString()
          });

          // Acknowledge receipt
          ws.send(JSON.stringify({
            type: 'notification',
            title: 'Support Ticket Received',
            message: 'Our helpdesk has received your ticket. An agent will follow up shortly.',
            timestamp: new Date().toISOString()
          }));
        }

      } catch (err) {
        console.error("Error processing WebSocket message:", err.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log("🔌 WebSocket client disconnected.");
    });
  });
}

/**
 * Sends a message to a specific user ID if connected.
 */
export function sendToUser(userId, data) {
  if (!wss) return;
  for (const [ws, info] of clients.entries()) {
    if (info.userId === userId) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }
  }
}

/**
 * Broadcasts a message to all authenticated admins.
 */
export function broadcastToAdmins(data) {
  if (!wss) return;
  for (const [ws, info] of clients.entries()) {
    if (info.role === 'ADMIN') {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }
  }
}

/**
 * Broadcasts a message to all connected clients.
 */
export function broadcastAll(data) {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
