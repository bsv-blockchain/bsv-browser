import React, { useCallback, useState } from 'react'
import {
  Animated,
  Dimensions,
  FlatList,
  InteractionManager,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Swipeable } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import * as Haptics from 'expo-haptics'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { IconButton } from '@/components/ui/IconButton'
import { spacing, radii } from '@/context/theme/tokens'
import tabStore from '@/stores/TabStore'
import type { Tab } from '@/shared/types/browser'

const kNEW_TAB_URL = 'about:blank'

interface TabsOverviewProps {
  onDismiss: () => void
  setAddressText: (text: string) => void
  setAddressFocused: (focused: boolean) => void
}

const TabsOverviewBase: React.FC<TabsOverviewProps> = ({
  onDismiss,
  setAddressText,
  setAddressFocused
}) => {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const screen = Dimensions.get('window')
  const ITEM_W = screen.width * 0.42
  const ITEM_H = screen.height * 0.28
  const insets = useSafeAreaInsets()
  const [isCreatingTab, setIsCreatingTab] = useState(false)

  const handleNewTabPress = useCallback(() => {
    if (isCreatingTab) return
    setIsCreatingTab(true)
    tabStore.newTab()
    Keyboard.dismiss()
    setAddressText(kNEW_TAB_URL)
    setTimeout(() => {
      setAddressFocused(false)
      onDismiss()
      setIsCreatingTab(false)
    }, 300)
  }, [onDismiss, setAddressText, isCreatingTab, setAddressFocused])

  const renderItem = ({ item }: { item: Tab }) => {
    const renderSwipeAction = (
      _progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>,
      direction: 'left' | 'right'
    ) => {
      const opacity = dragX.interpolate({
        inputRange: direction === 'left' ? [0, 100] : [-100, 0],
        outputRange: direction === 'left' ? [0, 1] : [1, 0],
        extrapolate: 'clamp'
      })
      return (
        <Animated.View style={[styles.swipeDelete, { backgroundColor: colors.error, opacity }]}>
          <Ionicons name="trash-outline" size={22} color="#fff" />
        </Animated.View>
      )
    }

    return (
      <Swipeable
        renderRightActions={(p, d) => renderSwipeAction(p, d, 'right')}
        renderLeftActions={(p, d) => renderSwipeAction(p, d, 'left')}
        friction={1}
        leftThreshold={10}
        rightThreshold={10}
        overshootLeft={false}
        overshootRight={false}
        onSwipeableWillOpen={() => {
          InteractionManager.runAfterInteractions(() => {
            setAddressFocused(false)
            Keyboard.dismiss()
            tabStore.closeTab(item.id)
          })
        }}
      >
        <Pressable
          style={[
            styles.tabPreview,
            {
              width: ITEM_W,
              height: ITEM_H,
              borderColor: item.id === tabStore.activeTabId ? colors.accent : colors.separator,
              borderWidth: item.id === tabStore.activeTabId ? 2.5 : StyleSheet.hairlineWidth,
              backgroundColor: colors.backgroundSecondary
            }
          ]}
          onPress={() => {
            tabStore.setActiveTab(item.id)
            onDismiss()
          }}
        >
          <TouchableOpacity
            style={[styles.closeButton, { backgroundColor: colors.fill }]}
            onPress={e => {
              e.stopPropagation()
              tabStore.closeTab(item.id)
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={14} color={colors.textPrimary} />
          </TouchableOpacity>

          <View style={{ flex: 1, overflow: 'hidden' }}>
            {item.url === kNEW_TAB_URL ? (
              <View style={styles.emptyTab}>
                <Text style={{ fontSize: 15, color: colors.textSecondary }}>{t('new_tab')}</Text>
              </View>
            ) : (
              <WebView
                source={{ uri: item.url || kNEW_TAB_URL }}
                style={{ flex: 1 }}
                scrollEnabled={false}
                androidLayerType={Platform.OS === 'android' ? 'software' : undefined as any}
                androidHardwareAccelerationDisabled={Platform.OS === 'android'}
                pointerEvents="none"
              />
            )}
            <View style={[styles.titleBar, { backgroundColor: colors.chromeBackground }]}>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.textPrimary, fontSize: 12 }}>
                {item.title || t('new_tab')}
              </Text>
            </View>
          </View>
        </Pressable>
      </Swipeable>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background + 'ee' }]}>
      <TouchableWithoutFeedback onPress={onDismiss}>
        <View style={StyleSheet.absoluteFill} />
      </TouchableWithoutFeedback>

      <FlatList
        data={tabStore.tabs.slice()}
        renderItem={renderItem}
        keyExtractor={item => item.id.toString()}
        numColumns={2}
        removeClippedSubviews={false}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={50}
        initialNumToRender={6}
        windowSize={10}
        extraData={tabStore.activeTabId}
        contentContainerStyle={{
          padding: spacing.md,
          paddingTop: spacing.xxxl,
          paddingBottom: 100,
        }}
      />

      <BlurChrome
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.separator,
          }
        ]}
      >
        <IconButton
          name="add"
          onPress={handleNewTabPress}
          size={24}
          color={colors.accent}
          disabled={isCreatingTab}
          accessibilityLabel="New tab"
        />
        <IconButton
          name="trash-outline"
          onPress={() => {
            if (Platform.OS === 'ios') {
              try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium) } catch {}
            }
            onDismiss()
            setAddressFocused(false)
            Keyboard.dismiss()
            tabStore.clearAllTabs()
          }}
          size={22}
          color={colors.accent}
          accessibilityLabel="Close all tabs"
        />
        <IconButton
          name="checkmark"
          onPress={onDismiss}
          size={24}
          color={colors.accent}
          accessibilityLabel="Done"
        />
      </BlurChrome>
    </View>
  )
}

export const TabsOverview = observer(TabsOverviewBase)

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  tabPreview: {
    margin: '4%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  emptyTab: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
  },
  swipeDelete: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
    marginVertical: 10,
    borderRadius: radii.md,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: spacing.lg,
  },
})
