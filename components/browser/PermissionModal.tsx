import React, { useRef } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'
import { useHaptics } from '@/hooks/useHaptics'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography, hitTargets } from '@/context/theme/tokens'
import { PermissionType } from '@/utils/permissionsManager'

interface PermissionModalProps {
    visible: boolean
    domain: string
    permission: PermissionType
    onDecision: (granted: boolean) => void
}

function iconForPermission(permission: PermissionType): React.ComponentProps<typeof Ionicons>['name'] {
    switch (permission) {
        case 'CAMERA':
            return 'camera'
        case 'RECORD_AUDIO':
            return 'mic'
        case 'NOTIFICATIONS':
            return 'notifications'
        case 'ACCESS_FINE_LOCATION':
        case 'ACCESS_COARSE_LOCATION':
            return 'location'
        default:
            return 'shield-checkmark'
    }
}

const PermissionModal: React.FC<PermissionModalProps> = ({ visible, domain, permission, onDecision }) => {
    const { colors } = useTheme()
    const haptics = useHaptics()
    // Guard against double-fire: once onDecision is called, further calls are no-ops
    // until the component remounts (parent uses key={pendingPermission}).
    const decidedRef = useRef(false)

    const decide = (granted: boolean) => {
        if (decidedRef.current) return
        decidedRef.current = true
        if (granted) {
            haptics.confirm()
        } else {
            haptics.warning()
        }
        onDecision(granted)
    }

    const friendlyLabelFor = (perm: PermissionType): string => {
        switch (perm) {
            case 'CAMERA':
                return 'Camera'
            case 'RECORD_AUDIO':
                return 'Microphone'
            case 'NOTIFICATIONS':
                return 'Notifications'
            case 'ACCESS_FINE_LOCATION':
            case 'ACCESS_COARSE_LOCATION':
                return 'Location'
            default: {
                const pretty = perm
                    .toLowerCase()
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase())
                return pretty
            }
        }
    }

    return (
        <Sheet
            visible={visible}
            onClose={() => {
                // Swipe-dismiss or backdrop tap — treat as deny but skip haptic
                // (decide() would fire warning; to avoid double-fire when deny
                // button was already pressed we use the decidedRef guard).
                if (!decidedRef.current) {
                    decidedRef.current = true
                    onDecision(false)
                }
            }}
            fitContent
        >
            <View style={styles.body}>
                {/* Permission icon circle */}
                <View style={[styles.iconCircle, { backgroundColor: colors.fillTertiary }]}>
                    <Ionicons
                        name={iconForPermission(permission)}
                        size={26}
                        color={colors.textPrimary}
                    />
                </View>

                {/* Title */}
                <Text style={[styles.title, { color: colors.textPrimary }]}>
                    Permission Request
                </Text>

                {/* Message */}
                <Text style={[styles.message, { color: colors.textSecondary }]}>
                    {domain} is requesting access to your {friendlyLabelFor(permission)}.
                </Text>

                {/* Button row */}
                <View style={styles.buttonRow}>
                    <PressableScale
                        style={[
                            styles.buttonDeny,
                            {
                                borderColor: colors.separator,
                                minHeight: hitTargets.minimum
                            }
                        ]}
                        onPress={() => decide(false)}
                    >
                        <Text style={[styles.buttonDenyText, { color: colors.textSecondary }]}>
                            Don't Allow
                        </Text>
                    </PressableScale>

                    <PressableScale
                        style={[
                            styles.buttonAllow,
                            {
                                backgroundColor: colors.accent,
                                minHeight: hitTargets.minimum
                            }
                        ]}
                        onPress={() => decide(true)}
                    >
                        <Text style={[styles.buttonAllowText, { color: colors.textOnAccent }]}>
                            Allow
                        </Text>
                    </PressableScale>
                </View>
            </View>
        </Sheet>
    )
}

const styles = StyleSheet.create({
    body: {
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.xl,
        alignItems: 'center'
    },
    iconCircle: {
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.md
    },
    title: {
        ...typography.headline,
        textAlign: 'center'
    },
    message: {
        ...typography.subhead,
        textAlign: 'center',
        marginTop: spacing.xs
    },
    buttonRow: {
        flexDirection: 'row',
        gap: spacing.md,
        marginTop: spacing.xl,
        width: '100%'
    },
    buttonDeny: {
        flex: 1,
        borderRadius: radii.lg,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center'
    },
    buttonDenyText: {
        ...typography.body
    },
    buttonAllow: {
        flex: 1,
        borderRadius: radii.lg,
        alignItems: 'center',
        justifyContent: 'center'
    },
    buttonAllowText: {
        ...typography.body,
        fontWeight: '600'
    }
})

export default PermissionModal
