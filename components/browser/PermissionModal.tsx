import React from 'react'
import { View, Text, Modal, StyleSheet, TouchableOpacity } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { PermissionType } from '@/utils/permissionsManager'

interface PermissionModalProps {
    visible: boolean
    domain: string
    permission: PermissionType
    onDecision: (granted: boolean) => void
}

const PermissionModal: React.FC<PermissionModalProps> = ({ visible, domain, permission, onDecision }) => {
    const { colors } = useTheme()

    const friendlyLabelFor = (permission: PermissionType) => {
        console.log('Gettting friendly label for', permission)
        switch (permission) {
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
                // Fallback: transform KEY_NAMES to Title Case words
                const pretty = permission
                    .toLowerCase()
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase())
                return pretty
            }
        }
    }

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade"
            onRequestClose={() => onDecision(false)}
        >
            <View style={styles.overlay}>
                <View style={[styles.container, { backgroundColor: colors.background }]}>
                    <Text style={[styles.title, { color: colors.textPrimary }]}>Permission Request</Text>
                    <Text style={[styles.message, { color: colors.textSecondary }]}>
                        The website {domain} is requesting access to your {friendlyLabelFor(permission)}.
                    </Text>

                    <View style={styles.buttonRow}>
                        <TouchableOpacity
                            onPress={() => onDecision(false)}
                            style={[styles.button, { backgroundColor: colors.buttonBackgroundDisabled }]}
                        >
                            <Text style={styles.buttonText}>Deny</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => onDecision(true)}
                            style={[styles.button, { backgroundColor: colors.buttonBackgroundDisabled }]}
                        >
                            <Text style={styles.buttonText}>Allow</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center'
    },
    container: {
        width: '85%',
        borderRadius: 12,
        padding: 20,
        elevation: 4
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12,
        textAlign: 'center'
    },
    message: {
        fontSize: 16,
        marginBottom: 20,
        textAlign: 'center'
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'space-evenly'
    },
    button: {
        paddingVertical: 10,
        paddingHorizontal: 25,
        borderRadius: 8
    },
    buttonText: {
        color: 'white',
        fontWeight: '600'
    }
})

export default PermissionModal
