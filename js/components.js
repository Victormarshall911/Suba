/**
 * SUBA Shared UI Components
 * Dynamic header, bottom nav, modals, toasts, accordion, carousel, animated counters
 */

const SUBAComponents = {

  /**
   * Initialize all shared components
   */
  init() {
    this.initHeader();
    this.initMobileMenu();
    this.initScrollAnimations();
    this.initAccordions();
    this.initToastContainer();
    this.initCookieConsent();
    this.initFloatingSupport();
  },

  /* ============================================
     HEADER
     ============================================ */

  initHeader() {
    const header = document.querySelector('.header');
    if (!header) return;

    let lastScroll = 0;
    const scrollThreshold = 50;

    window.addEventListener('scroll', SUBAUtils.throttle(() => {
      const currentScroll = window.scrollY;

      if (currentScroll > scrollThreshold) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }

      lastScroll = currentScroll;
    }, 100));
  },

  /* ============================================
     MOBILE MENU
     ============================================ */

  initMobileMenu() {
    const menuBtn = document.querySelector('.mobile-menu-btn');
    const mobileMenu = document.querySelector('.mobile-menu');
    if (!menuBtn || !mobileMenu) return;

    menuBtn.addEventListener('click', () => {
      menuBtn.classList.toggle('active');
      mobileMenu.classList.toggle('active');
      document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
    });

    // Close menu on link click
    mobileMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        menuBtn.classList.remove('active');
        mobileMenu.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  },

  /* ============================================
     SCROLL ANIMATIONS (Intersection Observer)
     ============================================ */

  initScrollAnimations() {
    const elements = document.querySelectorAll('.scroll-animate');
    if (!elements.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    });

    elements.forEach(el => observer.observe(el));
  },

  /* ============================================
     ACCORDION / FAQ
     ============================================ */

  initAccordions() {
    const items = document.querySelectorAll('.accordion-item');
    items.forEach(item => {
      const trigger = item.querySelector('.accordion-trigger');
      const content = item.querySelector('.accordion-content');
      if (!trigger || !content) return;

      trigger.addEventListener('click', () => {
        const isOpen = item.classList.contains('active');

        // Close all accordions in same group
        const parent = item.closest('.accordion-group');
        if (parent) {
          parent.querySelectorAll('.accordion-item.active').forEach(openItem => {
            if (openItem !== item) {
              openItem.classList.remove('active');
              openItem.querySelector('.accordion-content').style.maxHeight = '0';
            }
          });
        }

        // Toggle current
        item.classList.toggle('active');
        content.style.maxHeight = isOpen ? '0' : content.scrollHeight + 'px';
      });
    });
  },

  /* ============================================
     TOAST NOTIFICATIONS
     ============================================ */

  initToastContainer() {
    if (document.querySelector('.toast-container')) return;
    const container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toastContainer';
    document.body.appendChild(container);
  },

  /**
   * Show a toast notification
   * @param {object} options
   * @param {string} options.title - Toast title
   * @param {string} options.message - Toast message
   * @param {string} options.type - 'success' | 'error' | 'warning' | 'info'
   * @param {number} options.duration - Auto-dismiss time in ms (default 4000)
   */
  showToast({ title, message, type = 'info', duration = 4000 }) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-message">${message}</div>` : ''}
      </div>
      <button class="toast-dismiss" onclick="this.closest('.toast').remove()">✕</button>
    `;

    container.appendChild(toast);

    // Auto dismiss
    if (duration > 0) {
      setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 200);
      }, duration);
    }
  },

  /* ============================================
     MODAL
     ============================================ */

  /**
   * Open a modal
   * @param {string} id - Modal backdrop ID
   */
  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(id);
      }
    });

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        this.closeModal(id);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  },

  /**
   * Close a modal
   * @param {string} id - Modal backdrop ID
   */
  closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
  },

  /* ============================================
     ANIMATED COUNTER
     ============================================ */

  /**
   * Animate a number counting up
   * @param {HTMLElement} element - Target element
   * @param {number} target - Target number
   * @param {string} suffix - Suffix text (e.g., '+', '%', 'K+')
   * @param {number} duration - Duration in ms
   */
  animateCounter(element, target, suffix = '', duration = 2000) {
    if (!element) return;

    const start = 0;
    const startTime = performance.now();

    const update = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = Math.floor(start + (target - start) * easeOut);

      element.textContent = SUBAUtils.formatNumber(current) + suffix;

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    };

    requestAnimationFrame(update);
  },

  /**
   * Initialize all counters in view
   */
  initCounters() {
    const counters = document.querySelectorAll('[data-counter]');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const target = parseInt(el.dataset.counter, 10);
          const suffix = el.dataset.counterSuffix || '';
          this.animateCounter(el, target, suffix);
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(el => observer.observe(el));
  },

  /* ============================================
     TESTIMONIAL CAROUSEL
     ============================================ */

  initTestimonialCarousel() {
    const track = document.querySelector('.testimonials-track');
    const dots = document.querySelectorAll('.testimonial-dot');
    if (!track || !dots.length) return;

    let currentIndex = 0;
    const cards = track.querySelectorAll('.testimonial-card');
    const totalCards = cards.length;

    // Auto-rotate
    let autoplayTimer = setInterval(() => {
      currentIndex = (currentIndex + 1) % totalCards;
      scrollToCard(currentIndex);
    }, 5000);

    function scrollToCard(index) {
      const card = cards[index];
      if (!card) return;
      track.scrollTo({
        left: card.offsetLeft - track.offsetLeft - 16,
        behavior: 'smooth'
      });
      updateDots(index);
    }

    function updateDots(index) {
      dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
      });
    }

    // Dot click handlers
    dots.forEach((dot, i) => {
      dot.addEventListener('click', () => {
        currentIndex = i;
        scrollToCard(i);
        clearInterval(autoplayTimer);
        autoplayTimer = setInterval(() => {
          currentIndex = (currentIndex + 1) % totalCards;
          scrollToCard(currentIndex);
        }, 5000);
      });
    });

    // Pause on hover
    track.addEventListener('mouseenter', () => clearInterval(autoplayTimer));
    track.addEventListener('mouseleave', () => {
      autoplayTimer = setInterval(() => {
        currentIndex = (currentIndex + 1) % totalCards;
        scrollToCard(currentIndex);
      }, 5000);
    });
  },

  /* ============================================
     TABS
     ============================================ */

  /**
   * Initialize tab switching
   * @param {string} containerId - Container element ID
   * @param {Function} onChange - Callback with active tab value
   */
  initTabs(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const tabs = container.querySelectorAll('[data-tab]');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (onChange) onChange(tab.dataset.tab);
      });
    });
  },

  /* ============================================
     TOGGLE / SWITCH
     ============================================ */

  initToggles() {
    document.querySelectorAll('.toggle-wrapper').forEach(wrapper => {
      const toggle = wrapper.querySelector('.toggle');
      if (!toggle) return;

      wrapper.addEventListener('click', () => {
        toggle.classList.toggle('active');
        const event = new CustomEvent('toggle-change', {
          detail: { active: toggle.classList.contains('active') }
        });
        wrapper.dispatchEvent(event);
      });
    });
  },

  /* ============================================
     OTP INPUT
     ============================================ */

  initOTPInputs() {
    const inputs = document.querySelectorAll('.otp-input');
    if (!inputs.length) return;

    inputs.forEach((input, index) => {
      input.addEventListener('input', (e) => {
        const value = e.target.value;
        if (value.length === 1) {
          input.classList.add('filled');
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
          inputs[index - 1].focus();
          inputs[index - 1].classList.remove('filled');
        }
      });

      // Prevent non-numeric input
      input.addEventListener('beforeinput', (e) => {
        if (e.data && !/^\d$/.test(e.data)) {
          e.preventDefault();
        }
      });
    });
  },

  /* ============================================
     LOADING SKELETON
     ============================================ */

  /**
   * Show/hide skeleton loading in an element
   * @param {HTMLElement} element
   * @param {boolean} show
   */
  toggleSkeleton(element, show) {
    if (!element) return;
    if (show) {
      element.dataset.originalContent = element.innerHTML;
      element.innerHTML = `
        <div class="skeleton skeleton-text w-75"></div>
        <div class="skeleton skeleton-text w-50"></div>
        <div class="skeleton skeleton-card" style="margin-top: 12px;"></div>
      `;
    } else if (element.dataset.originalContent) {
      element.innerHTML = element.dataset.originalContent;
      delete element.dataset.originalContent;
    }
  },

  /* ============================================
     BOTTOM NAVIGATION ACTIVE STATE
     ============================================ */

  setActiveNav(page) {
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
  },

  /* ============================================
     COOKIE CONSENT BANNER
     ============================================ */
  initCookieConsent() {
    // Only run on user-facing pages, don't show inside admin
    if (window.location.pathname.includes('/admin/')) return;
    if (localStorage.getItem('suba_cookie_consent')) return;

    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.id = 'cookieConsentBanner';
    banner.innerHTML = `
      <div class="cookie-banner-content">
        <span class="cookie-icon">🍪</span>
        <p>SUBA uses cookies to deliver fast, secure, and reliable VTU services. By using our site, you agree to our <a href="policies.html?tab=privacy">Privacy Policy</a>.</p>
      </div>
      <div class="cookie-banner-actions">
        <button class="btn btn-ghost btn-sm" id="declineCookiesBtn" style="color: var(--clr-text-secondary);">Decline</button>
        <button class="btn btn-primary btn-sm" id="acceptCookiesBtn">Accept Cookies</button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('acceptCookiesBtn').addEventListener('click', () => {
      localStorage.setItem('suba_cookie_consent', 'accepted');
      banner.classList.add('cookie-banner-hide');
      setTimeout(() => banner.remove(), 400);
    });

    document.getElementById('declineCookiesBtn').addEventListener('click', () => {
      localStorage.setItem('suba_cookie_consent', 'declined');
      banner.classList.add('cookie-banner-hide');
      setTimeout(() => banner.remove(), 400);
    });
  },

  /* ============================================
     FLOATING SUPPORT WIDGET
     ============================================ */
  initFloatingSupport() {
    // Don't show in admin area
    if (window.location.pathname.includes('/admin/')) return;
    if (document.getElementById('supportWidgetContainer')) return;

    const widget = document.createElement('div');
    widget.className = 'support-widget-container';
    widget.id = 'supportWidgetContainer';
    widget.innerHTML = `
      <button class="support-floating-btn" id="supportFloatingBtn" aria-label="Contact Support">
        <span class="support-btn-icon">💬</span>
      </button>
      
      <div class="support-popover" id="supportPopover">
        <div class="support-popover-header">
          <div style="font-weight: 700; color: white;">SUBA Support</div>
          <div style="font-size: 11px; color: rgba(255,255,255,0.85)">Active: 8:00 AM – 10:00 PM WAT</div>
        </div>
        <div class="support-popover-body">
          <p style="margin-bottom: var(--space-3); font-size: 12px; color: var(--clr-text-secondary); line-height: 1.4;">
            Need quick assistance with your transaction?
          </p>
          
          <a href="https://wa.me/2348000000000" target="_blank" class="support-channel-link whatsapp" style="text-decoration: none;">
            <span class="channel-icon">🟢</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Chat on WhatsApp</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Instant replies • 24/7 active</div>
            </div>
          </a>
          
          <a href="mailto:support@suba.ng" class="support-channel-link email" style="text-decoration: none; margin-top: 8px; display: flex;">
            <span class="channel-icon">✉️</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Email Support</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Replies within 4 hours</div>
            </div>
          </a>

          <a href="policies.html?tab=support" class="support-channel-link policy" style="text-decoration: none; margin-top: 8px; display: flex;">
            <span class="channel-icon">📄</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Support Policy</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Read support hours & guidelines</div>
            </div>
          </a>
          
          <div class="support-ticket-form" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--clr-border-light);">
            <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px; color: var(--clr-text-primary)">Submit Quick Ticket</div>
            <textarea id="quickSupportMsg" class="form-textarea" placeholder="Describe your transaction issue..." rows="2" style="font-size: 11px; padding: 6px 10px; resize: none; margin-bottom: 8px;"></textarea>
            <button class="btn btn-primary btn-sm btn-block" id="sendQuickSupportBtn" style="font-size: 11px; padding: 6px 12px; border-radius: var(--radius-md);">Submit Message</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(widget);

    const floatBtn = document.getElementById('supportFloatingBtn');
    const popover = document.getElementById('supportPopover');

    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#supportWidgetContainer')) {
        popover.classList.remove('active');
      }
    });

    const sendBtn = document.getElementById('sendQuickSupportBtn');
    const msgText = document.getElementById('quickSupportMsg');

    sendBtn.addEventListener('click', () => {
      const msg = msgText.value.trim();
      if (!msg) {
        SUBAComponents.showToast({
          title: 'Empty Message',
          message: 'Please describe your query first.',
          type: 'warning'
        });
        return;
      }

      sendBtn.classList.add('is-loading');
      setTimeout(() => {
        sendBtn.classList.remove('is-loading');
        msgText.value = '';
        popover.classList.remove('active');
        SUBAComponents.showToast({
          title: 'Ticket Submitted!',
          message: 'Support team will contact you shortly.',
          type: 'success'
        });
      }, 1200);
    });
  }
};

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  SUBAComponents.init();
});
